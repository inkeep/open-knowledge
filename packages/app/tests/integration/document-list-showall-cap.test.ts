/**
 * Entry-cap floor for `GET /api/documents?showAll=true`. A content directory
 * pointed at a large tree must not accumulate unbounded entries — the walk
 * stops at `OK_SHOWALL_MAX_ENTRIES` and the response reports `truncated`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentListSuccessSchema } from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { awaitFileWatcherIndexed, createTestServer, type TestServer } from './test-harness';

const FIXTURE_FILE_COUNT = 25;
let server: TestServer;

beforeAll(async () => {
  const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-showall-cap-')));
  for (let i = 0; i < FIXTURE_FILE_COUNT; i++) {
    const name = `file-${String(i).padStart(2, '0')}.md`;
    writeFileSync(join(contentDir, name), `# File ${i}\n`);
  }
  server = await createTestServer({ contentDir, keepContentDir: false });
  await awaitFileWatcherIndexed(server, 'file-00');
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

async function fetchShowAll() {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/documents?showAll=true`);
  expect(res.ok).toBe(true);
  return DocumentListSuccessSchema.parse(await res.json());
}

async function fetchDefaultRaw(): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`);
  expect(res.ok).toBe(true);
  return (await res.json()) as Record<string, unknown>;
}

describe('GET /api/documents?showAll=true entry cap', () => {
  test('a low OK_SHOWALL_MAX_ENTRIES truncates the walk and reports truncated:true', async () => {
    const cap = 5;
    const prev = process.env.OK_SHOWALL_MAX_ENTRIES;
    process.env.OK_SHOWALL_MAX_ENTRIES = String(cap);
    try {
      const body = await fetchShowAll();
      expect(body.truncated).toBe(true);
      expect(body.documents.length).toBeLessThanOrEqual(cap);
      expect(body.documents.length).toBeGreaterThan(0);
    } finally {
      if (prev === undefined) delete process.env.OK_SHOWALL_MAX_ENTRIES;
      else process.env.OK_SHOWALL_MAX_ENTRIES = prev;
    }
  });

  test('the default cap leaves a small fixture untruncated', async () => {
    const prev = process.env.OK_SHOWALL_MAX_ENTRIES;
    delete process.env.OK_SHOWALL_MAX_ENTRIES;
    try {
      const body = await fetchShowAll();
      expect(body.truncated).toBeUndefined();
      const docNames = body.documents.filter((e) => e.kind === 'document').map((e) => e.docName);
      expect(docNames).toContain('file-00');
      expect(docNames).toContain('file-24');
    } finally {
      if (prev === undefined) delete process.env.OK_SHOWALL_MAX_ENTRIES;
      else process.env.OK_SHOWALL_MAX_ENTRIES = prev;
    }
  });

  test('the non-showAll branch never emits a truncated key (AC3 / D3)', async () => {
    // `truncated` is set ONLY by the showAll branch; absence means
    // "not applicable", keeping legacy clients valid. Assert key ABSENCE on
    // the raw body — `'truncated' in body === false`, not merely `== null`.
    const body = await fetchDefaultRaw();
    expect('truncated' in body).toBe(false);
    // The body still satisfies the shared success schema (truncated optional).
    expect(DocumentListSuccessSchema.safeParse(body).success).toBe(true);
  });
});
