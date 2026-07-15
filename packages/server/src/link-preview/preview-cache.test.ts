import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LinkPreviewMetadata } from '@inkeep/open-knowledge-core';
import {
  LinkPreviewCache,
  type LinkPreviewCacheOptions,
  type LinkPreviewOutcome,
  normalizePreviewUrl,
} from './preview-cache.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ok-linkpreview-cache-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeCache(over: Partial<LinkPreviewCacheOptions> = {}): LinkPreviewCache {
  return new LinkPreviewCache({ cacheDir: dir, ...over });
}

function ok(domain: string, extra: Partial<LinkPreviewMetadata> = {}): LinkPreviewOutcome {
  return { ok: true, metadata: { domain, ...extra } };
}

/** A compute closure plus a call counter — the seam that proves hit vs miss. */
function counter(outcome: LinkPreviewOutcome): [() => Promise<LinkPreviewOutcome>, () => number] {
  let n = 0;
  return [
    async () => {
      n += 1;
      return outcome;
    },
    () => n,
  ];
}

/** A compute that fails the test if it runs — asserts a lookup was a cache hit. */
const mustNotFetch = async (): Promise<LinkPreviewOutcome> => {
  throw new Error('expected a cache hit, but compute ran');
};

describe('normalizePreviewUrl', () => {
  test('strips the fragment and userinfo, keeps scheme+host+path+query', () => {
    expect(normalizePreviewUrl('https://ex.com/p?q=1#a')).toBe(
      normalizePreviewUrl('https://ex.com/p?q=1#b'),
    );
    expect(normalizePreviewUrl('https://ex.com/p?q=1#frag')).toBe('https://ex.com/p?q=1');
    expect(normalizePreviewUrl('https://user:pw@ex.com/p')).toBe('https://ex.com/p');
  });

  test('returns null for an unparseable URL', () => {
    expect(normalizePreviewUrl('not a url')).toBeNull();
  });
});

describe('LinkPreviewCache', () => {
  test('success → persist → re-init serves the metadata from disk (round-trip)', async () => {
    const cache = makeCache();
    await cache.init();
    const metadata: LinkPreviewMetadata = {
      domain: 'example.com',
      title: 'Example',
      description: 'A description',
      siteName: 'Example Site',
      faviconDataUri: 'data:image/png;base64,iVBORw0KGgo=',
    };
    await cache.load('https://example.com/page', counter({ ok: true, metadata })[0]);
    await cache.persist();
    expect(existsSync(join(dir, 'manifest.json'))).toBe(true);
    expect(readdirSync(join(dir, 'meta')).length).toBe(1);

    const reopened = makeCache();
    await reopened.init();
    // Fragment differs but normalizes to the same key — still a disk hit.
    expect(await reopened.load('https://example.com/page#section', mustNotFetch)).toEqual({
      ok: true,
      metadata,
    });
  });

  test('caches a negative outcome and serves it without recomputing', async () => {
    const cache = makeCache();
    await cache.init();
    const first = await cache.load(
      'https://n.com/',
      counter({ ok: false, reason: 'private-ip' })[0],
    );
    expect(first).toEqual({ ok: false, reason: 'private-ip' });

    // A later hover offering a *different* outcome must still get the cached failure.
    const [compute, calls] = counter(ok('n.com'));
    expect(await cache.load('https://n.com/', compute)).toEqual({
      ok: false,
      reason: 'private-ip',
    });
    expect(calls()).toBe(0);
  });

  test('a success past its TTL is a miss and recomputes', async () => {
    let clock = 1_000_000;
    const cache = makeCache({ successTtlMs: 5000, now: () => clock });
    await cache.init();
    const [first, firstCalls] = counter(ok('s.com'));
    await cache.load('https://s.com/', first);
    expect(firstCalls()).toBe(1);

    const [withinTtl, withinCalls] = counter(ok('s.com'));
    await cache.load('https://s.com/', withinTtl);
    expect(withinCalls()).toBe(0); // still fresh → hit

    clock += 6000; // past the 5s success TTL
    const [afterTtl, afterCalls] = counter(ok('s.com'));
    await cache.load('https://s.com/', afterTtl);
    expect(afterCalls()).toBe(1); // expired → recompute
  });

  test('a negative past its short TTL recomputes so a dead link recovers', async () => {
    let clock = 1_000_000;
    const cache = makeCache({ negativeTtlMs: 1000, now: () => clock });
    await cache.init();
    await cache.load('https://nt.com/', counter({ ok: false, reason: 'timeout' })[0]);

    clock += 2000; // past the 1s negative TTL
    const [compute, calls] = counter(ok('nt.com'));
    expect(await cache.load('https://nt.com/', compute)).toEqual(ok('nt.com'));
    expect(calls()).toBe(1);
  });

  test('coalesces concurrent identical lookups into a single compute (single-flight)', async () => {
    const cache = makeCache();
    await cache.init();
    let resolveGate!: (o: LinkPreviewOutcome) => void;
    const gate = new Promise<LinkPreviewOutcome>((resolve) => {
      resolveGate = resolve;
    });
    let calls = 0;
    const compute = () => {
      calls += 1;
      return gate;
    };

    const p1 = cache.load('https://x.com/', compute);
    const p2 = cache.load('https://x.com/', compute);
    resolveGate(ok('x.com'));
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(calls).toBe(1);
    expect(r1).toEqual(ok('x.com'));
    expect(r2).toEqual(ok('x.com'));
  });

  test('clears the in-flight slot when compute throws (no stuck key, no caching)', async () => {
    const cache = makeCache();
    await cache.init();
    await expect(
      cache.load('https://y.com/', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // The failed compute was not cached and the slot is free → the next load runs.
    const [compute, calls] = counter(ok('y.com'));
    expect(await cache.load('https://y.com/', compute)).toEqual(ok('y.com'));
    expect(calls()).toBe(1);
  });

  test('evicts the least-recently-used entry past the size cap', async () => {
    const cache = makeCache({ maxEntries: 2 });
    await cache.init();
    await cache.load('https://a.com/', counter(ok('a.com'))[0]);
    await cache.load('https://b.com/', counter(ok('b.com'))[0]);
    await cache.load('https://c.com/', counter(ok('c.com'))[0]); // evicts a (oldest)
    expect(cache.size).toBe(2);

    const [reA, reACalls] = counter(ok('a.com'));
    await cache.load('https://a.com/', reA);
    expect(reACalls()).toBe(1); // a was evicted → recompute

    // c was accessed more recently than b, so it survived — a hit.
    await cache.load('https://c.com/', mustNotFetch);

    await cache.persist();
    // Only the two live entries have blobs on disk; the evicted one is GC'd.
    expect(readdirSync(join(dir, 'meta')).length).toBe(2);
  });

  test('a hit bumps recency so the next eviction drops the older un-accessed key', async () => {
    const cache = makeCache({ maxEntries: 2 });
    await cache.init();
    await cache.load('https://a.com/', counter(ok('a.com'))[0]); // {a}
    await cache.load('https://b.com/', counter(ok('b.com'))[0]); // {a,b}
    await cache.load('https://a.com/', mustNotFetch); // hit bumps a → {b,a}
    await cache.load('https://c.com/', counter(ok('c.com'))[0]); // adding c evicts b (now oldest) → {a,c}

    // The bump moved a's recency above b, so b — not a — was the eviction victim.
    // Assert a's survival before recomputing b, since recomputing b would itself
    // evict the next-oldest entry.
    await cache.load('https://a.com/', mustNotFetch); // a survived → hit
    const [reB, reBCalls] = counter(ok('b.com'));
    await cache.load('https://b.com/', reB);
    expect(reBCalls()).toBe(1); // b was evicted → recompute
  });

  test('a corrupt manifest is treated as empty and never throws', async () => {
    writeFileSync(join(dir, 'manifest.json'), 'not-json{{{');
    const cache = makeCache();
    await cache.init(); // must not throw
    expect(cache.size).toBe(0);

    const [compute, calls] = counter(ok('c.com'));
    await cache.load('https://c.com/', compute);
    expect(calls()).toBe(1); // empty cache → computes
  });

  test('a success blob that no longer matches the schema drops the entry', async () => {
    const cache = makeCache();
    await cache.init();
    await cache.load('https://b.com/page', counter(ok('b.com'))[0]);
    await cache.persist();
    const [blob] = readdirSync(join(dir, 'meta'));
    writeFileSync(join(dir, 'meta', blob as string), '{"unexpected":true}'); // valid JSON, wrong shape

    const reopened = makeCache();
    await reopened.init(); // drops the entry, no throw
    const [compute, calls] = counter(ok('b.com'));
    await reopened.load('https://b.com/page', compute);
    expect(calls()).toBe(1); // unusable blob → recompute
  });

  test('drops an already-expired entry on init (no resurrection)', async () => {
    let clock = 1_000_000;
    const cache = makeCache({ negativeTtlMs: 1000, now: () => clock });
    await cache.init();
    await cache.load('https://g.com/', counter({ ok: false, reason: 'timeout' })[0]);
    await cache.persist();

    clock += 2000; // the persisted entry is now stale
    const reopened = makeCache({ negativeTtlMs: 1000, now: () => clock });
    await reopened.init();
    expect(reopened.size).toBe(0);
    const [compute, calls] = counter(ok('g.com'));
    await reopened.load('https://g.com/', compute);
    expect(calls()).toBe(1);
  });

  test('memory-only mode (cacheDir null) caches in memory and never touches disk', async () => {
    const cache = new LinkPreviewCache({ cacheDir: null });
    await cache.init();
    const [compute, calls] = counter(ok('m.com'));
    await cache.load('https://m.com/', compute);
    await cache.load('https://m.com/', compute); // hit
    expect(calls()).toBe(1);
    await expect(cache.persist()).resolves.toBeUndefined(); // no-op, no throw
    expect(readdirSync(dir).length).toBe(0);
  });

  test('wipe clears memory and the on-disk cache directory', async () => {
    const cache = makeCache();
    await cache.init();
    await cache.load('https://w.com/', counter(ok('w.com'))[0]);
    await cache.persist();
    expect(existsSync(join(dir, 'manifest.json'))).toBe(true);

    await cache.wipe();
    expect(existsSync(dir)).toBe(false);

    const [compute, calls] = counter(ok('w.com'));
    await cache.load('https://w.com/', compute);
    expect(calls()).toBe(1); // memory cleared → recompute
  });

  test('persist is best-effort when the cache directory is unwritable', async () => {
    // A regular file where the cache dir should be → mkdir(meta) fails with ENOTDIR.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    const cache = new LinkPreviewCache({ cacheDir: join(blocker, 'nested') });
    await cache.init(); // no throw

    await cache.load('https://e.com/', counter(ok('e.com'))[0]);
    await expect(cache.persist()).resolves.toBeUndefined(); // swallows the fs error

    // The failed flush left the in-memory cache intact — still a hit.
    const [compute, calls] = counter(ok('e.com'));
    expect(await cache.load('https://e.com/', compute)).toEqual(ok('e.com'));
    expect(calls()).toBe(0);
  });
});
