/**
 * Single-flight dedupe + abort-on-disconnect for `GET /api/documents?showAll=true`
 * Concurrent identical walks must collapse to one traversal (the
 * `concurrent_walks` heap multiplier → 1), the in-flight entry must evict on
 * settle (no stale caching), distinct `dir` shapes must not coalesce, and a
 * walk whose last waiter disconnects must abort at the next directory boundary.
 *
 * Walk counting uses the server's `__getShowAllWalkStatsForTesting()` seam:
 * `invocations` counts how many times the walk actually ran, `aborts` counts
 * walks that bailed on their signal. The integration server and this test share
 * one `@inkeep/open-knowledge-server` module instance, so the counter is the
 * same object the handler increments.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentListSuccessSchema } from '@inkeep/open-knowledge-core';
import {
  __getShowAllWalkStatsForTesting,
  __resetShowAllWalkStatsForTesting,
} from '@inkeep/open-knowledge-server';
import { createTestServer, pollUntil, type TestServer } from './test-harness';

// The fixture is intentionally large AND deep so one walk spans many event-loop
// ticks: it gives single-flight coalescing a wide window, and — critically for
// the disconnect test — keeps the walk in flight long enough that an abort fired
// right after the walk starts reliably lands mid-traversal on fast hardware.
// Each nested directory adds realpath + readdir + stat awaits on top of the
// per-file stats, so the walk duration dwarfs the abort round-trip latency.
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
  // A wide nested tree: more directory boundaries → more realpath/readdir
  // awaits → a reliably long walk for the abort-on-disconnect test.
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
  server = await createTestServer({ contentDir, keepContentDir: false });
}, 60_000);

afterAll(async () => {
  await server.cleanup();
});

describe('single-flight dedupe (AC1, AC2)', () => {
  test('N concurrent identical requests trigger exactly one walk and share the result', async () => {
    // Coalescing relies on the handler inserting the in-flight entry synchronously
    // between the map miss and set (api-extension.ts, the showAll branch - no
    // `await` in that window). If a future refactor introduces an await there,
    // these requests would each start a walk and `invocations` would jump to N,
    // failing this assertion.
    __resetShowAllWalkStatsForTesting();
    const N = 10;
    const responses = await Promise.all(Array.from({ length: N }, () => fetch(showAllUrl())));
    for (const res of responses) expect(res.ok).toBe(true);
    const bodies = await Promise.all(
      responses.map(async (res) => DocumentListSuccessSchema.parse(await res.json())),
    );

    // Exactly one underlying walk despite N concurrent callers.
    expect(__getShowAllWalkStatsForTesting().invocations).toBe(1);

    // Every coalesced caller received the identical sorted result.
    const first = bodies[0];
    expect(first).toBeDefined();
    for (const body of bodies) {
      expect(body.documents.length).toBe(first?.documents.length);
    }
    expect(bodies[1]).toEqual(first);
    // Sanity: the shared walk actually surfaced the fixture.
    expect(first?.documents.length ?? 0).toBeGreaterThan(ROOT_FILE_COUNT);
  }, 30_000);

  test('two sequential requests each trigger their own walk (entry evicts on settle)', async () => {
    __resetShowAllWalkStatsForTesting();
    const a = DocumentListSuccessSchema.parse(await (await fetch(showAllUrl())).json());
    const b = DocumentListSuccessSchema.parse(await (await fetch(showAllUrl())).json());
    // No stale caching: each fully-awaited request re-walks.
    expect(__getShowAllWalkStatsForTesting().invocations).toBe(2);
    // ...and still returns the same view.
    expect(b.documents.length).toBe(a.documents.length);
  }, 30_000);

  test('concurrent requests for distinct dirs do not coalesce', async () => {
    __resetShowAllWalkStatsForTesting();
    const [ra, rb] = await Promise.all([fetch(showAllUrl('dir-a')), fetch(showAllUrl('dir-b'))]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    await ra.json();
    await rb.json();
    // Distinct keys (`showAll:dir-a` vs `showAll:dir-b`) → two independent walks.
    expect(__getShowAllWalkStatsForTesting().invocations).toBe(2);
  }, 30_000);

  test('a truncated coalesced walk delivers truncated:true to every waiter', async () => {
    // The truncation signal is computed once inside the shared walk and must
    // reach all coalesced callers through the single shared result.
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

describe('abort-on-disconnect (AC4)', () => {
  test.skip('a disconnect with no other waiter aborts the shared walk', async () => {
    __resetShowAllWalkStatsForTesting();
    const controller = new AbortController();
    // Capture the rejection so the deliberate abort never surfaces as an
    // unhandled rejection.
    const rejected = fetch(showAllUrl(), { signal: controller.signal }).then(
      () => false,
      () => true,
    );

    // Abort only once the walk has actually started, so the abort lands
    // mid-traversal rather than before the request reaches the handler. Budgets
    // are generous because the full integration suite runs many servers
    // concurrently — under that CPU load the walk start and the abort round-trip
    // (socket close → refcount → next directory-boundary check) can each take
    // several seconds. The per-test timeout below must exceed their sum.
    await pollUntil(() => __getShowAllWalkStatsForTesting().invocations >= 1, 12_000, 5);
    controller.abort();

    // The server observes the disconnect, refcount hits zero, and the walk
    // bails at the next directory boundary.
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
