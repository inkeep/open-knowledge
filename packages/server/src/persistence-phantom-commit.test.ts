import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
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

  test('a transaction that leaves the bytes unchanged → principal NOT recorded', async () => {
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
        const ytext = serverDoc.getText('source');
        ytext.insert(0, 'x');
        ytext.delete(0, 1);
      }, connectionOrigin);

      await expectContributorCountRemainsAt(0, { durationMs: 800 });
      conn.disconnect();
    } finally {
      await server.destroy();
    }

    expect(contributorCount()).toBe(0);
  });

  test('a blank line appended at the tail → principal IS recorded', async () => {
    writeFileSync(
      join(fixture.contentDir, 'tail-empty-doc.md'),
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
      const conn = await server.hocuspocus.openDirectConnection('tail-empty-doc');
      const serverDoc = server.hocuspocus.documents.get('tail-empty-doc');
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;

      serverDoc.transact(
        () => {
          const ytext = serverDoc.getText('source');
          ytext.insert(ytext.length, '\n');
        },
        {
          source: 'connection' as const,
          connection: { context: { principalId: 'principal-test-tail-empty' } },
        },
      );

      await waitForContributorCount(1);
      conn.disconnect();
    } finally {
      await server.destroy();
    }

    expect(contributorCount()).toBe(1);
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
        const ytext = serverDoc.getText('source');
        ytext.insert(ytext.length, '\nappended by the user\n');
      }, connectionOrigin);

      await waitForContributorCount(1);
      conn.disconnect();
    } finally {
      await server.destroy();
    }

    expect(contributorCount()).toBe(1);
  });
});
