import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { contributorCount, swapContributors } from './contributor-tracker.ts';
import { createServer } from './server-factory.ts';

async function waitForContributorCount(
  expected: number,
  { timeoutMs = 5_000, pollMs = 10 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (contributorCount() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(
    `Expected contributorCount() === ${expected} within ${timeoutMs}ms, got ${contributorCount()}`,
  );
}

async function expectContributorCountRemainsAt(
  expected: number,
  { durationMs = 800, pollMs = 50 }: { durationMs?: number; pollMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    const actual = contributorCount();
    if (actual !== expected) {
      throw new Error(
        `contributorCount() drifted from ${expected} to ${actual} within ${durationMs}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

interface Fixture {
  tmpDir: string;
  contentDir: string;
  cleanup: () => void;
}

async function setupFixture(): Promise<Fixture> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ok-phantom-commit-'));
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

describe('onStoreDocument phantom-principal-commit regression (PR #295)', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await setupFixture();
    swapContributors();
  });

  afterEach(() => {
    swapContributors();
    fixture.cleanup();
  });

  test('y-prosemirror-style empty-paragraph append → principal NOT recorded', async () => {
    writeFileSync(
      join(fixture.contentDir, 'empty-para-doc.md'),
      '# Original heading\n\nOriginal body.\n',
      'utf-8',
    );
    const server = createServer({
      contentDir: fixture.contentDir,
      projectDir: fixture.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
    });
    await server.ready;
    try {
      const conn = await server.hocuspocus.openDirectConnection('empty-para-doc');
      const serverDoc = server.hocuspocus.documents.get('empty-para-doc');
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;

      const connectionOrigin = {
        source: 'connection' as const,
        connection: { context: { principalId: 'principal-test-phantom' } },
      };
      serverDoc.transact(() => {
        serverDoc.getXmlFragment('default').push([new Y.XmlElement('paragraph')]);
      }, connectionOrigin);

      await expectContributorCountRemainsAt(0, { durationMs: 800 });
      conn.disconnect();
    } finally {
      await server.destroy();
    }

    expect(contributorCount()).toBe(0);
  });

  test('real user edit changes serialized markdown → principal IS recorded', async () => {
    writeFileSync(
      join(fixture.contentDir, 'real-edit-doc.md'),
      '# Original heading\n\nOriginal body.\n',
      'utf-8',
    );
    const server = createServer({
      contentDir: fixture.contentDir,
      projectDir: fixture.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
    });
    await server.ready;
    try {
      const conn = await server.hocuspocus.openDirectConnection('real-edit-doc');
      const serverDoc = server.hocuspocus.documents.get('real-edit-doc');
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;

      const connectionOrigin = {
        source: 'connection' as const,
        connection: { context: { principalId: 'principal-test-real-edit' } },
      };
      serverDoc.transact(() => {
        const frag = serverDoc.getXmlFragment('default');
        const newPara = new Y.XmlElement('paragraph');
        newPara.insert(0, [new Y.XmlText('appended by the user')]);
        frag.push([newPara]);
      }, connectionOrigin);

      await waitForContributorCount(1);
      conn.disconnect();
    } finally {
      await server.destroy();
    }

    expect(contributorCount()).toBe(1);
  });
});
