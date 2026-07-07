/**
 * Integration tests for empty folder visibility in /api/documents.
 *
 * These tests cover the two paths by which empty folders reach the API:
 *   1. Boot-time: folder exists on disk before server starts
 *   2. Live-creation: folder created externally while server is running
 *
 * Both paths were added. These tests confirm both work end-to-end
 * through the full HTTP stack (not just the watcher layer unit tests in
 * file-watcher.test.ts).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentListSuccessSchema } from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, type TestServer, wait } from './test-harness';

const LIVE_FOLDER_TIMEOUT_MS = 45_000;
const LIVE_FOLDER_TEST_TIMEOUT_MS = LIVE_FOLDER_TIMEOUT_MS + 5_000;

async function awaitFolderPathsIndexed(
  server: TestServer,
  expectedFolderPaths: readonly string[],
  timeoutMs = LIVE_FOLDER_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastFolderPaths: string[] = [];
  while (Date.now() < deadline) {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`).catch(() => null);
    if (res?.ok) {
      const body = DocumentListSuccessSchema.parse(await res.json());
      lastFolderPaths = body.documents.filter((e) => e.kind === 'folder').map((e) => e.path ?? '');
      if (expectedFolderPaths.every((path) => lastFolderPaths.includes(path))) {
        return;
      }
    }
    await wait(50);
  }
  throw new Error(
    `folder paths not indexed within ${timeoutMs}ms: expected=${expectedFolderPaths.join(
      ',',
    )}; last=${lastFolderPaths.join(',')}`,
  );
}

// ─── Scenario 1: boot-time empty folder ──────────────────────────────────────

describe('/api/documents empty folder — boot-time', () => {
  let server: TestServer;

  beforeAll(async () => {
    // Create the content directory with an empty subfolder BEFORE starting the server.
    // seedLastKnownHashes must pick this up during boot.
    const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-empty-folder-boot-')));
    writeFileSync(join(contentDir, 'readme.md'), '# Root\n', 'utf-8');
    mkdirSync(join(contentDir, 'empty-folder'), { recursive: true });
    mkdirSync(join(contentDir, 'nested', 'empty-child'), { recursive: true });
    server = await createTestServer({ contentDir, keepContentDir: false });
  }, HARNESS_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await server.cleanup();
  });

  test('returns empty subfolder created before server start', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`);
    expect(res.ok).toBe(true);
    // Parse through schema so any shape regression surfaces here.
    const body = DocumentListSuccessSchema.parse(await res.json());
    const folders = body.documents.filter((e) => e.kind === 'folder');
    const folderPaths = folders.map((e) => e.path);
    expect(folderPaths).toContain('empty-folder');
  });

  test('returns nested empty folder hierarchy created before server start', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`);
    expect(res.ok).toBe(true);
    const body = DocumentListSuccessSchema.parse(await res.json());
    const folderPaths = body.documents.filter((e) => e.kind === 'folder').map((e) => e.path);
    expect(folderPaths).toContain('nested');
    expect(folderPaths).toContain('nested/empty-child');
  });
});

// ─── Scenario 2: live-created empty folder ────────────────────────────────────

describe('/api/documents empty folder — live creation', () => {
  let server: TestServer;

  beforeAll(async () => {
    const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-empty-folder-live-')));
    writeFileSync(join(contentDir, 'readme.md'), '# Root\n', 'utf-8');
    server = await createTestServer({ contentDir, keepContentDir: false });
  }, HARNESS_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await server.cleanup();
  });

  test(
    'detects empty folder created externally after server start',
    async () => {
      // Create an empty folder externally (simulating OS/terminal creation).
      mkdirSync(join(server.contentDir, 'live-empty'));

      await awaitFolderPathsIndexed(server, ['live-empty']);
    },
    LIVE_FOLDER_TEST_TIMEOUT_MS,
  );

  test(
    'detects deeply-nested empty folder hierarchy created with mkdir -p',
    async () => {
      // Simulate `mkdir -p a/b/c` from terminal — all three levels are new.
      mkdirSync(join(server.contentDir, 'deep', 'nested', 'empty'), { recursive: true });

      await awaitFolderPathsIndexed(server, ['deep', 'deep/nested', 'deep/nested/empty']);
    },
    LIVE_FOLDER_TEST_TIMEOUT_MS,
  );
});
