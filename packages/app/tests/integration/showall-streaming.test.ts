/**
 * NDJSON streaming for `GET /api/documents?showAll=true` over the
 * real HTTP API. An `Accept: application/x-ndjson` request must stream one
 * `DocumentListEntry` per line plus a terminal `{type:'complete'}` verdict, the
 * client consumer must reassemble the same listing the buffered JSON path
 * returns, and a request WITHOUT the NDJSON Accept must still get the buffered
 * single-flight JSON response unchanged (back-compatible coexistence). The cap
 * propagates as `truncated` on the terminal line.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentListSuccessSchema } from '@inkeep/open-knowledge-core';
import { consumeShowAllStream, isNdjsonResponse } from '../../src/lib/show-all-stream';
import { createTestServer, type TestServer } from './test-harness';

const ROOT_FILE_COUNT = 40;
let server: TestServer;

function showAllUrl(dir?: string): string {
  const base = `http://127.0.0.1:${server.port}/api/documents?showAll=true`;
  return dir ? `${base}&dir=${encodeURIComponent(dir)}` : base;
}

beforeAll(async () => {
  const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-showall-stream-it-')));
  for (let i = 0; i < ROOT_FILE_COUNT; i++) {
    writeFileSync(join(contentDir, `file-${String(i).padStart(3, '0')}.md`), `# File ${i}\n`);
  }
  mkdirSync(join(contentDir, 'sub'));
  writeFileSync(join(contentDir, 'sub', 'note.md'), '# sub\n');
  server = await createTestServer({ contentDir, keepContentDir: false });
}, 60_000);

afterAll(async () => {
  await server.cleanup();
});

describe('showAll NDJSON streaming (PRD-6856)', () => {
  test('Accept: application/x-ndjson streams entries plus a terminal complete line', async () => {
    const res = await fetch(showAllUrl(), { headers: { Accept: 'application/x-ndjson' } });
    expect(res.ok).toBe(true);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');

    const lines = (await res.text()).split('\n').filter((line) => line.length > 0);
    const parsed = lines.map((line) => JSON.parse(line));
    const complete = parsed.filter((row) => row.type === 'complete');
    const entries = parsed.filter((row) => row.type === undefined);

    // Exactly one terminal verdict, and it reports the streamed count.
    expect(complete.length).toBe(1);
    expect(complete[0].truncated).toBe(false);
    expect(complete[0].count).toBe(entries.length);
    // The fixture surfaced (root files + the sub dir + its note).
    expect(entries.length).toBeGreaterThan(ROOT_FILE_COUNT);
    for (const entry of entries) expect(entry.type).toBeUndefined();
  }, 30_000);

  test('the client consumer reassembles the same listing the buffered JSON path returns', async () => {
    const streamRes = await fetch(showAllUrl(), { headers: { Accept: 'application/x-ndjson' } });
    expect(isNdjsonResponse(streamRes)).toBe(true);
    const streamed = await consumeShowAllStream(streamRes);

    const bufferedRes = await fetch(showAllUrl());
    const buffered = DocumentListSuccessSchema.parse(await bufferedRes.json());

    const sortKey = (e: { kind: string; docName?: string; path?: string }) =>
      e.kind === 'folder' ? (e.path ?? '') : (e.docName ?? e.path ?? '');
    const streamedKeys = streamed.entries.map(sortKey).sort();
    const bufferedKeys = buffered.documents.map(sortKey).sort();
    expect(streamedKeys).toEqual(bufferedKeys);
    expect(streamed.truncated).toBe(false);
  }, 30_000);

  test('a request without the NDJSON Accept still gets buffered JSON (coexistence)', async () => {
    const res = await fetch(showAllUrl());
    expect(res.ok).toBe(true);
    expect(res.headers.get('content-type')).toContain('application/json');
    // Parses as a single JSON blob — the single-flight path is unchanged.
    const body = DocumentListSuccessSchema.parse(await res.json());
    expect(body.documents.length).toBeGreaterThan(ROOT_FILE_COUNT);
  }, 30_000);

  test('the entry cap propagates as truncated on the terminal line', async () => {
    const prev = process.env.OK_SHOWALL_MAX_ENTRIES;
    process.env.OK_SHOWALL_MAX_ENTRIES = '5';
    try {
      const streamRes = await fetch(showAllUrl(), { headers: { Accept: 'application/x-ndjson' } });
      const { entries, truncated } = await consumeShowAllStream(streamRes);
      expect(truncated).toBe(true);
      expect(entries.length).toBeLessThanOrEqual(5);
    } finally {
      if (prev === undefined) delete process.env.OK_SHOWALL_MAX_ENTRIES;
      else process.env.OK_SHOWALL_MAX_ENTRIES = prev;
    }
  }, 30_000);
});
