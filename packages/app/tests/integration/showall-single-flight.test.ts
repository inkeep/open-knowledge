import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentListSuccessSchema } from '@inkeep/open-knowledge-core';
import {
  __getShowAllWalkStatsForTesting,
  __resetShowAllWalkStatsForTesting,
} from '@inkeep/open-knowledge-server';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestServer, pollUntil, type TestServer } from './test-harness';

const ROOT_FILE_COUNT = 1500;
const NESTED_DIR_COUNT = 30;
const FILES_PER_NESTED_DIR = 40;
let server: TestServer;

function showAllUrl(dir?: string): string {
  const base = `http://127.0.0.1:${server.port}/api/documents?showAll=true`;
  return dir ? `${base}&dir=${encodeURIComponent(dir)}` : base;
}

beforeAll(async () => {
  const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-showall-sf-')));
  for (let i = 0; i < ROOT_FILE_COUNT; i++) {
    writeFileSync(join(contentDir, `file-${String(i).padStart(4, '0')}.md`), `# File ${i}\n`);
  }
  for (let d = 0; d < NESTED_DIR_COUNT; d++) {
    const dirPath = join(contentDir, 'nested', `d-${String(d).padStart(2, '0')}`);
    mkdirSync(dirPath, { recursive: true });
    for (let f = 0; f < FILES_PER_NESTED_DIR; f++) {
      writeFileSync(join(dirPath, `n-${String(f).padStart(2, '0')}.md`), `# Nested ${d}/${f}\n`);
    }
  }
  for (const sub of ['dir-a', 'dir-b']) {
    mkdirSync(join(contentDir, sub));
    writeFileSync(join(contentDir, sub, 'note.md'), `# ${sub}\n`);
  }
  mkdirSync(join(contentDir, '.ok', 'templates'), { recursive: true });
  writeFileSync(join(contentDir, '.ok', 'templates', 'daily.md'), '# Daily\n');
  server = await createTestServer({ contentDir, keepContentDir: false });
}, 60_000);

afterAll(async () => {
  await server.cleanup();
});

describe('single-flight dedupe (AC1, AC2)', () => {
  test('N concurrent identical requests trigger exactly one walk and share the result', async () => {
    __resetShowAllWalkStatsForTesting();
    const N = 10;
    const responses = await Promise.all(Array.from({ length: N }, () => fetch(showAllUrl())));
    for (const res of responses) expect(res.ok).toBe(true);
    const bodies = await Promise.all(
      responses.map(async (res) => DocumentListSuccessSchema.parse(await res.json())),
    );

    expect(__getShowAllWalkStatsForTesting().invocations).toBe(1);

    const first = bodies[0];
    expect(first).toBeDefined();
    for (const body of bodies) {
      expect(body.documents.length).toBe(first?.documents.length);
    }
    expect(bodies[1]).toEqual(first);
    expect(first?.documents.length ?? 0).toBeGreaterThan(ROOT_FILE_COUNT);
  }, 30_000);

  test('two sequential requests each trigger their own walk (entry evicts on settle)', async () => {
    __resetShowAllWalkStatsForTesting();
    const a = DocumentListSuccessSchema.parse(await (await fetch(showAllUrl())).json());
    const b = DocumentListSuccessSchema.parse(await (await fetch(showAllUrl())).json());
    expect(__getShowAllWalkStatsForTesting().invocations).toBe(2);
    expect(b.documents.length).toBe(a.documents.length);
  }, 30_000);

  test('concurrent requests for distinct dirs do not coalesce', async () => {
    __resetShowAllWalkStatsForTesting();
    const [ra, rb] = await Promise.all([fetch(showAllUrl('dir-a')), fetch(showAllUrl('dir-b'))]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    await ra.json();
    await rb.json();
    expect(__getShowAllWalkStatsForTesting().invocations).toBe(2);
  }, 30_000);

  test('a truncated coalesced walk delivers truncated:true to every waiter', async () => {
    const prev = process.env.OK_SHOWALL_MAX_ENTRIES;
    process.env.OK_SHOWALL_MAX_ENTRIES = '50';
    try {
      __resetShowAllWalkStatsForTesting();
      const N = 6;
      const responses = await Promise.all(Array.from({ length: N }, () => fetch(showAllUrl())));
      const bodies = await Promise.all(
        responses.map(async (res) => DocumentListSuccessSchema.parse(await res.json())),
      );
      expect(__getShowAllWalkStatsForTesting().invocations).toBe(1);
      for (const body of bodies) {
        expect(body.truncated).toBe(true);
        expect(body.documents.length).toBeLessThanOrEqual(50);
      }
    } finally {
      if (prev === undefined) delete process.env.OK_SHOWALL_MAX_ENTRIES;
      else process.env.OK_SHOWALL_MAX_ENTRIES = prev;
    }
  }, 30_000);
});

describe('showOk single-flight isolation', () => {
  test('concurrent showAll and showAll+showOk requests never coalesce', async () => {
    __resetShowAllWalkStatsForTesting();
    const [plainRes, revealRes] = await Promise.all([
      fetch(showAllUrl()),
      fetch(`${showAllUrl()}&showOk=true`),
    ]);
    expect(plainRes.ok).toBe(true);
    expect(revealRes.ok).toBe(true);
    const plain = DocumentListSuccessSchema.parse(await plainRes.json());
    const reveal = DocumentListSuccessSchema.parse(await revealRes.json());

    expect(__getShowAllWalkStatsForTesting().invocations).toBe(2);

    const pathOf = (e: { kind: string; docName?: string; path?: string }) =>
      e.kind === 'folder' ? (e.path ?? '') : (e.docName ?? e.path ?? '');
    expect(plain.documents.map(pathOf).some((p) => p.split('/').includes('.ok'))).toBe(false);
    expect(reveal.documents.map(pathOf)).toContain('.ok/templates/daily');
  }, 30_000);
});

describe('abort-on-disconnect (AC4)', () => {
  test.skip('a disconnect with no other waiter aborts the shared walk', async () => {
    __resetShowAllWalkStatsForTesting();
    const controller = new AbortController();
    const rejected = fetch(showAllUrl(), { signal: controller.signal }).then(
      () => false,
      () => true,
    );

    await pollUntil(() => __getShowAllWalkStatsForTesting().invocations >= 1, 12_000, 5);
    controller.abort();

    await pollUntil(() => __getShowAllWalkStatsForTesting().aborts >= 1, 12_000, 5);
    expect(__getShowAllWalkStatsForTesting().aborts).toBe(1);
    expect(await rejected).toBe(true);
  }, 30_000);

  test('a normally-completed request never triggers an abort', async () => {
    __resetShowAllWalkStatsForTesting();
    const res = await fetch(showAllUrl());
    expect(res.ok).toBe(true);
    await res.json();
    const stats = __getShowAllWalkStatsForTesting();
    expect(stats.invocations).toBe(1);
    expect(stats.aborts).toBe(0);
  }, 30_000);
});
