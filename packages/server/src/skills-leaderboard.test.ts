import { afterEach, describe, expect, test } from 'vitest';
import {
  __resetPopularSkillsCache,
  __resetPublisherSkillsCache,
  getPopularSkills,
  getPublisherSkills,
} from './skills-leaderboard.ts';

const flight = (rows: Array<[string, string, number]>): string =>
  `0:[${rows
    .map(
      ([s, k, n]) =>
        `{"source":${JSON.stringify(s)},"skillId":${JSON.stringify(k)},"installs":${n}}`,
    )
    .join(',')}]`;

const fixtureFetch = (body: string, status = 200): typeof fetch =>
  (async () => new Response(body, { status })) as unknown as typeof fetch;

describe('getPopularSkills', () => {
  afterEach(__resetPopularSkillsCache);

  test('maps + install-sorts the scraped payload into SkillSearchResults', async () => {
    const body = flight([
      ['a/b', 'x', 10],
      ['c/d', 'y', 99],
      ['a/b', 'z', 50],
    ]);
    const rows = await getPopularSkills(24, { fetchImpl: fixtureFetch(body) });
    expect(rows.map((r) => r.id)).toEqual(['c/d/y', 'a/b/z', 'a/b/x']);
    expect(rows[0]).toMatchObject({ name: 'y', source: 'c/d', installs: 99, publisher: 'c' });
  });

  test('best-effort: [] on a non-OK response (never throws into Discover)', async () => {
    expect(await getPopularSkills(24, { fetchImpl: fixtureFetch('x', 500) })).toEqual([]);
  });

  test('best-effort: [] on an unparseable body', async () => {
    expect(
      await getPopularSkills(24, { fetchImpl: fixtureFetch('<html>no cards</html>') }),
    ).toEqual([]);
  });

  test('caches within the TTL — one upstream fetch across calls', async () => {
    let calls = 0;
    const counting = (async () => {
      calls++;
      return new Response(flight([['a/b', 'x', 1]]), { status: 200 });
    }) as unknown as typeof fetch;
    await getPopularSkills(24, { fetchImpl: counting, now: 1000 });
    await getPopularSkills(24, { fetchImpl: counting, now: 1000 + 60_000 });
    expect(calls).toBe(1);
  });

  test('limit truncates the ranked list', async () => {
    const body = flight([
      ['a/b', 'x', 10],
      ['c/d', 'y', 99],
      ['a/b', 'z', 50],
    ]);
    expect(await getPopularSkills(2, { fetchImpl: fixtureFetch(body) })).toHaveLength(2);
  });
});

const listing = (source: string, skillId: string, installs: number): string =>
  `<a class="group grid" href="/${source}/${skillId}">` +
  `<h3 class="font-semibold">${skillId}</h3>` +
  `<span class="font-mono text-sm">${installs}</span></a>`;

describe('getPublisherSkills', () => {
  afterEach(__resetPublisherSkillsCache);

  test('install-sorts one publisher’s listing', async () => {
    const body = listing('a/b', 'x', 10) + listing('a/b', 'y', 99);
    const rows = await getPublisherSkills('a/b', { fetchImpl: fixtureFetch(body) });
    expect(rows.map((r) => r.id)).toEqual(['a/b/y', 'a/b/x']);
    expect(rows[0]).toMatchObject({ name: 'y', source: 'a/b', installs: 99, publisher: 'a' });
  });

  test('best-effort: [] on a non-OK response, so the caller keeps its unranked list', async () => {
    expect(await getPublisherSkills('a/b', { fetchImpl: fixtureFetch('x', 500) })).toEqual([]);
  });

  test('best-effort: [] on an unparseable page', async () => {
    expect(
      await getPublisherSkills('a/b', { fetchImpl: fixtureFetch('<html>no rows</html>') }),
    ).toEqual([]);
  });

  test('caches per publisher within the TTL', async () => {
    let calls = 0;
    const counting = (async () => {
      calls++;
      return new Response(listing('a/b', 'x', 1), { status: 200 });
    }) as unknown as typeof fetch;
    await getPublisherSkills('a/b', { fetchImpl: counting, now: 1000 });
    await getPublisherSkills('a/b', { fetchImpl: counting, now: 1000 + 60_000 });
    expect(calls).toBe(1);
    await getPublisherSkills('c/d', { fetchImpl: counting, now: 1000 + 60_000 });
    expect(calls).toBe(2);
  });

  test('a stale entry answers a failed refetch rather than emptying the list', async () => {
    let calls = 0;
    const flaky = (async () => {
      calls++;
      return calls === 1
        ? new Response(listing('a/b', 'x', 7), { status: 200 })
        : new Response('boom', { status: 503 });
    }) as unknown as typeof fetch;
    await getPublisherSkills('a/b', { fetchImpl: flaky, now: 1000 });
    const afterTtl = await getPublisherSkills('a/b', { fetchImpl: flaky, now: 1000 + 11 * 60_000 });
    expect(afterTtl.map((r) => r.name)).toEqual(['x']);
  });
});
