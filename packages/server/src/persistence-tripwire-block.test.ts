import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { updateYFragment } from '@tiptap/y-tiptap';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as Y from 'yjs';
import { mdManager, schema } from './md-manager.ts';
import { createServer } from './server-factory.ts';

const FIXTURE_DIR = resolve(import.meta.dirname, 'persistence-tripwire.fixtures');

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf-8');
}

interface Fixture {
  tmpDir: string;
  contentDir: string;
  cleanup: () => void;
}

async function setupFixture(): Promise<Fixture> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ok-tripwire-'));
  const contentDir = tmpDir;
  const git = simpleGit({ baseDir: tmpDir });
  await git.init();
  await git.addConfig('user.name', 'Test User');
  await git.addConfig('user.email', 'test@example.com');
  return {
    tmpDir,
    contentDir,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  };
}

function replaceFragmentFromMarkdown(doc: Y.Doc, markdown: string): void {
  const json = mdManager.parseWithFallback(markdown);
  const pmNode = schema.nodeFromJSON(json);
  const xmlFragment = doc.getXmlFragment('default');
  doc.transact(
    () => {
      updateYFragment(doc, xmlFragment, pmNode, { mapping: new Map(), isOMark: new Map() });
    },
    { source: 'connection', connection: { context: { principalId: 'principal-test-tripwire' } } },
  );
}

async function waitForCondition(
  predicate: () => boolean,
  { timeoutMs = 5_000, pollMs = 25 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`waitForCondition timed out after ${timeoutMs}ms`);
}

async function expectStable<T>(
  read: () => T,
  { durationMs = 600, pollMs = 50 }: { durationMs?: number; pollMs?: number } = {},
): Promise<T> {
  const initial = read();
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    if (read() !== initial) {
      throw new Error('value changed during stability window');
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return initial;
}

describe('persistence onStoreDocument tripwire', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await setupFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test('blocks doubled candidate, leaves disk unchanged, resets the live doc to disk', async () => {
    const docName = 'incident-changeset-readme';
    const docPath = join(fixture.contentDir, `${docName}.md`);
    const baseMarkdown = loadFixture('incident-changeset-readme-doubled.base.md');
    const doubledMarkdown = loadFixture('incident-changeset-readme-doubled.candidate.md');
    writeFileSync(docPath, baseMarkdown, 'utf-8');
    const baselineBytes = readFileSync(docPath, 'utf-8');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = createServer({
      contentDir: fixture.contentDir,
      projectDir: fixture.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
    });
    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;

      const baseChildren = serverDoc.getXmlFragment('default').length;
      expect(baseChildren).toBeGreaterThan(0);

      replaceFragmentFromMarkdown(serverDoc, doubledMarkdown);
      const doubledChildren = serverDoc.getXmlFragment('default').length;
      expect(doubledChildren).toBe(baseChildren * 2);

      await waitForCondition(() => {
        return warnSpy.mock.calls.some((call) => {
          const arg = String(call[0] ?? '');
          return arg.includes('"event":"ok-persistence-duplication-blocked"');
        });
      });

      await expectStable(() => readFileSync(docPath, 'utf-8'));
      expect(readFileSync(docPath, 'utf-8')).toBe(baselineBytes);

      await waitForCondition(() => serverDoc.getXmlFragment('default').length === baseChildren);
      expect(serverDoc.getXmlFragment('default').length).toBe(baseChildren);
      await waitForCondition(() => serverDoc.getText('source').toString() === baselineBytes);
      expect(serverDoc.getText('source').toString()).toBe(baselineBytes);

      const blockedCalls = warnSpy.mock.calls
        .map((call) => String(call[0] ?? ''))
        .filter((s) => s.includes('"event":"ok-persistence-duplication-blocked"'));
      expect(blockedCalls.length).toBe(1);
      const payload = JSON.parse(blockedCalls[0] ?? '{}') as Record<string, unknown>;
      expect(payload.event).toBe('ok-persistence-duplication-blocked');
      expect(payload['doc.name']).toBe(docName);
      expect(payload.copies).toBe(2);
      expect(payload.reason).toBe('structural-duplication');
      expect(typeof payload.candidateBytes).toBe('number');
      expect(typeof payload.baseBytes).toBe('number');
      expect(typeof payload.fragmentChildren).toBe('number');
      expect(new Set(Object.keys(payload))).toEqual(
        new Set([
          'event',
          'doc.name',
          'candidateBytes',
          'baseBytes',
          'fragmentChildren',
          'copies',
          'reason',
        ]),
      );

      conn.disconnect();
    } finally {
      warnSpy.mockRestore();
      await server.destroy();
    }

    expect(readFileSync(docPath, 'utf-8')).toBe(baselineBytes);
  });

  test('intentional whole-document duplicate edit falls through to the normal write path', async () => {
    const docName = 'intentional-faq-repeated';
    const docPath = join(fixture.contentDir, `${docName}.md`);
    const baseMarkdown = loadFixture('intentional-faq-repeated-section.base.md');
    const candidateMarkdown = loadFixture('intentional-faq-repeated-section.candidate.md');
    writeFileSync(docPath, baseMarkdown, 'utf-8');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = createServer({
      contentDir: fixture.contentDir,
      projectDir: fixture.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
    });
    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;

      replaceFragmentFromMarkdown(serverDoc, candidateMarkdown);

      const baselineSize = readFileSync(docPath, 'utf-8').length;
      await waitForCondition(() => readFileSync(docPath, 'utf-8').length !== baselineSize);

      const finalContent = readFileSync(docPath, 'utf-8');
      expect(finalContent.length).toBeGreaterThan(baselineSize);

      const blockedCalls = warnSpy.mock.calls
        .map((call) => String(call[0] ?? ''))
        .filter((s) => s.includes('"event":"ok-persistence-duplication-blocked"'));
      expect(blockedCalls.length).toBe(0);

      conn.disconnect();
    } finally {
      warnSpy.mockRestore();
      await server.destroy();
    }
  });
});
