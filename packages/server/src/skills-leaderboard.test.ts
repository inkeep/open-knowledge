import { afterEach, describe, expect, test } from 'vitest';
import { __resetPopularSkillsCache, getPopularSkills } from './skills-leaderboard.ts';

// Build a minimal raw Flight payload from (source, skillId, installs) triples, in
// the field order the real skills.sh payload uses.
//
// Each card is a brace-delimited OBJECT, because that is what RSC Flight
// actually serializes a card as. This helper used to emit bare `"key":value`
// runs directly inside the array — not valid JSON, and a shape Flight cannot
// produce — which only parsed because the old scanner matched loose key/value
// pairs anywhere in the stream. The sibling fixture in
// `core/src/skills-catalog/leaderboard.test.ts` has always used objects.
const flight = (rows: Array<[string, string, number]>): string =>
  `0:[${rows
    .map(
      ([s, k, n]) =>
        `{"source":${JSON.stringify(s)},"skillId":${JSON.stringify(k)},"installs":${n}}`,
    )
    .join(',')}]`;

// A fake `fetch` returning a fixture body — stubs the one boundary (HTTP) we
// don't own, so the fetch→parse→map→cache pipeline runs deterministically.
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
    await getPopularSkills(24, { fetchImpl: counting, now: 1000 + 60_000 }); // < TTL
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
