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

describe('/api/documents empty folder — boot-time', () => {
  let server: TestServer;

  beforeAll(async () => {
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
      mkdirSync(join(server.contentDir, 'live-empty'));

      await awaitFolderPathsIndexed(server, ['live-empty']);
    },
    LIVE_FOLDER_TEST_TIMEOUT_MS,
  );

  test(
    'detects deeply-nested empty folder hierarchy created with mkdir -p',
    async () => {
      mkdirSync(join(server.contentDir, 'deep', 'nested', 'empty'), { recursive: true });

      await awaitFolderPathsIndexed(server, ['deep', 'deep/nested', 'deep/nested/empty']);
    },
    LIVE_FOLDER_TEST_TIMEOUT_MS,
  );
});
