import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as Y from 'yjs';
import { lossCaptureCurrentPath, parseLossCaptureLines } from './loss-capture.ts';
import { mdManager, schema } from './md-manager.ts';
import { getMetrics, resetMetrics } from './metrics.ts';
import { classifyDuplication } from './persistence-tripwire.ts';
import { createServer } from './server-factory.ts';
import { initShadowRepo, type ShadowHandle, shadowGit } from './shadow-repo.ts';
import { getDocumentHistory } from './timeline-query.ts';

const FIXTURE_DIR = resolve(import.meta.dirname, 'persistence-tripwire.fixtures');

const USER_DOC = 'hello\n\n\nkjnekandkjawnkjd\n\n\nwkajnd\n\n\nwk\n\n\nwwjwj\n';
const USER_DOC_LINE = 'kjnekandkjawnkjd';

const BROWSER_ORIGIN = {
  source: 'connection',
  connection: { context: { principalId: 'principal-test-paste' } },
} as const;

const P = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
const EMPTY = { type: 'paragraph' };

const TYPED_CHILDREN = [
  P('hello'),
  EMPTY,
  P(USER_DOC_LINE),
  EMPTY,
  P('wkajnd'),
  EMPTY,
  P('wk'),
  EMPTY,
  P('wwjwj'),
];

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf-8');
}

function occurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 8_000, pollMs = 25 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

async function expectStable<T>(
  read: () => T,
  { durationMs = 700, pollMs = 50 }: { durationMs?: number; pollMs?: number } = {},
): Promise<T> {
  const initial = read();
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    if (read() !== initial) throw new Error('value changed during stability window');
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return initial;
}

interface Rig {
  tmpDir: string;
  shadow: ShadowHandle;
  cleanup: () => void;
}

async function setupRig(prefix: string): Promise<Rig> {
  const tmpDir = await realpath(mkdtempSync(join(tmpdir(), prefix)));
  const git = simpleGit({ baseDir: tmpDir });
  await git.init();
  await git.raw('symbolic-ref', 'HEAD', 'refs/heads/main');
  await git.addConfig('user.name', 'Test User');
  await git.addConfig('user.email', 'test@example.com');
  const shadow = await initShadowRepo(tmpDir);
  return {
    tmpDir,
    shadow,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  };
}

function replaceFragment(doc: Y.Doc, content: unknown[]): void {
  const xmlFragment = doc.getXmlFragment('default');
  doc.transact(() => {
    updateYFragment(doc, xmlFragment, schema.nodeFromJSON({ type: 'doc', content }), {
      mapping: new Map(),
      isOMark: new Map(),
    });
  }, BROWSER_ORIGIN);
}

function liveChildren(frag: Y.XmlFragment): unknown[] {
  const json = yXmlFragmentToProseMirrorRootNode(frag, schema).toJSON() as {
    content?: unknown[];
  };
  return json.content ?? [];
}

function blockedEvents(warnSpy: { mock: { calls: unknown[][] } }): string[] {
  return warnSpy.mock.calls
    .map((call) => String(call[0] ?? ''))
    .filter((s) => s.includes('"event":"ok-persistence-duplication-blocked"'));
}

describe('persistence tripwire vs a whole-document paste', () => {
  let rig: Rig;

  beforeEach(() => {
    resetMetrics();
  });

  afterEach(() => {
    rig?.cleanup();
  });

  test('the classifier still reads a whole-document double as a block verdict', () => {
    expect(USER_DOC.length).toBe(47);
    expect(classifyDuplication(`${USER_DOC}\n${USER_DOC}`, USER_DOC)).toEqual({
      kind: 'block',
      reason: 'structural-duplication',
      copies: 2,
    });
  });

  test('select-all copy paste after a settled write survives and reaches disk', async () => {
    rig = await setupRig('ok-tripwire-paste-');
    const docName = 'Untitled';
    const docPath = join(rig.tmpDir, `${docName}.md`);
    writeFileSync(docPath, '', 'utf-8');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = createServer({
      contentDir: rig.tmpDir,
      projectDir: rig.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
      shadowRepo: rig.shadow,
    });

    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;
      const frag = serverDoc.getXmlFragment('default');

      replaceFragment(serverDoc, TYPED_CHILDREN);
      await waitFor(() => readFileSync(docPath, 'utf-8').length > 0);
      const baseline = readFileSync(docPath, 'utf-8');
      expect(baseline).toBe(USER_DOC);

      const kids = liveChildren(frag);
      replaceFragment(serverDoc, [...kids, ...kids]);
      expect(occurrences(serverDoc.getText('source').toString(), USER_DOC_LINE)).toBe(2);

      await waitFor(() => readFileSync(docPath, 'utf-8') !== baseline);
      const persisted = await expectStable(() => readFileSync(docPath, 'utf-8'));
      expect(occurrences(persisted, USER_DOC_LINE)).toBe(2);
      expect(persisted.length).toBeGreaterThan(baseline.length);

      expect(occurrences(serverDoc.getText('source').toString(), USER_DOC_LINE)).toBe(2);
      expect(frag.length).toBeGreaterThan(TYPED_CHILDREN.length);

      expect(blockedEvents(warnSpy)).toHaveLength(0);
      expect(getMetrics().persistenceDuplicationReset).toBe(0);
      expect(getMetrics().persistenceDuplicationSpared).toBe(1);

      const spared = warnSpy.mock.calls
        .map((call) => String(call[0] ?? ''))
        .filter((s) => s.includes('"event":"ok-persistence-duplication-spared"'));
      expect(spared).toHaveLength(1);
      const sparedPayload = JSON.parse(spared[0] ?? '{}') as Record<string, unknown>;
      expect(new Set(Object.keys(sparedPayload))).toEqual(
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
      expect(sparedPayload['doc.name']).toBe(docName);
      expect(sparedPayload.copies).toBe(2);

      conn.disconnect();
    } finally {
      warnSpy.mockRestore();
      await server.destroy();
    }
  }, 30_000);

  test('a doubling with no settled write behind it still blocks, resets, and checkpoints', async () => {
    rig = await setupRig('ok-tripwire-incident-');
    const docName = 'incident-changeset-readme';
    const docPath = join(rig.tmpDir, `${docName}.md`);
    const baseMarkdown = loadFixture('incident-changeset-readme-doubled.base.md');
    const doubledMarkdown = loadFixture('incident-changeset-readme-doubled.candidate.md');
    writeFileSync(docPath, baseMarkdown, 'utf-8');
    const baselineBytes = readFileSync(docPath, 'utf-8');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = createServer({
      contentDir: rig.tmpDir,
      projectDir: rig.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
      shadowRepo: rig.shadow,
    });

    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;

      const baseChildren = serverDoc.getXmlFragment('default').length;
      expect(baseChildren).toBeGreaterThan(0);

      const doubledJson = mdManager.parseWithFallback(doubledMarkdown) as { content?: unknown[] };
      replaceFragment(serverDoc, doubledJson.content ?? []);
      expect(serverDoc.getXmlFragment('default').length).toBe(baseChildren * 2);

      await waitFor(() => blockedEvents(warnSpy).length > 0);

      await expectStable(() => readFileSync(docPath, 'utf-8'));
      expect(readFileSync(docPath, 'utf-8')).toBe(baselineBytes);
      await waitFor(() => serverDoc.getXmlFragment('default').length === baseChildren);
      await waitFor(() => serverDoc.getText('source').toString() === baselineBytes);
      expect(getMetrics().persistenceDuplicationReset).toBe(1);

      await waitFor(() => getMetrics().persistenceDuplicationResetCheckpointCreated >= 1, {
        timeoutMs: 10_000,
      });
      const shas = (
        await shadowGit(rig.shadow).raw(
          'for-each-ref',
          '--format=%(objectname)',
          'refs/checkpoints',
        )
      )
        .toString()
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      expect(shas).toHaveLength(1);
      const sha = shas[0] ?? '';

      const blob = (await shadowGit(rig.shadow).raw('show', `${sha}:${docName}`)).toString();
      expect(occurrences(blob, 'changeset')).toBeGreaterThan(
        occurrences(baselineBytes, 'changeset'),
      );
      const hist = await getDocumentHistory(rig.shadow, { docName }, '');
      const row = hist.entries.find((e) => e.sha === sha);
      expect(row?.checkpoint?.kind).toBe('persistence-duplication-reset');
      expect(row?.checkpoint?.metadata).toEqual({ copies: 2, fragmentChildren: baseChildren * 2 });

      const ring = parseLossCaptureLines(
        readFileSync(lossCaptureCurrentPath(rig.tmpDir), 'utf-8'),
      ).filter((e) => e.site === 'persistence-duplication-reset');
      const trips = ring.filter((e) => e.event === 'detector-trip');
      expect(trips).toHaveLength(1);
      expect(trips[0]?.docName).toBe(docName);
      expect(trips[0]?.lostLen ?? 0).toBeGreaterThan(0);
      expect(ring.some((e) => e.event === 'checkpoint-write' && e.checkpointSha === sha)).toBe(
        true,
      );

      conn.disconnect();
    } finally {
      warnSpy.mockRestore();
      await server.destroy();
    }
  }, 30_000);
});
