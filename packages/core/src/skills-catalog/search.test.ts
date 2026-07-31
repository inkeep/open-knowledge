import { describe, expect, test } from 'vitest';
import { parseGitHubRepoSearch, parseOpenGraph, parseSkillsShSearch } from './search.ts';

describe('parseSkillsShSearch', () => {
  test('maps valid rows with owner/repo source', () => {
    const r = parseSkillsShSearch({
      skills: [{ id: 'acme/repo/foo', name: 'foo', source: 'acme/repo', installs: 12 }],
    });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      id: 'acme/repo/foo',
      source: 'acme/repo',
      installs: 12,
      publisher: 'acme',
    });
  });

  test('tolerates shape drift (non-array, malformed rows)', () => {
    expect(parseSkillsShSearch({})).toEqual([]);
    expect(parseSkillsShSearch({ skills: 'nope' })).toEqual([]);
    expect(parseSkillsShSearch(null)).toEqual([]);
    // A row with no source and no id is unimportable → skipped.
    expect(parseSkillsShSearch({ skills: [{ name: 'x' }] })).toEqual([]);
  });

  test('clamps out-of-contract installs (negative / non-integer) to null', () => {
    // Schema requires int().nonnegative(); a bad upstream row must degrade to null
    // rather than fail the whole search response's validation.
    expect(
      parseSkillsShSearch({ skills: [{ id: 'a/b/c', name: 'c', source: 'a/b', installs: -5 }] })[0]
        .installs,
    ).toBeNull();
    expect(
      parseSkillsShSearch({ skills: [{ id: 'a/b/c', name: 'c', source: 'a/b', installs: 1.5 }] })[0]
        .installs,
    ).toBeNull();
  });

  test('defaults installs to null and derives name from the id when absent', () => {
    const r = parseSkillsShSearch({ skills: [{ source: 'a/b' }] });
    expect(r[0].installs).toBeNull();
    expect(r[0].name).toBe('b');
  });
});

describe('parseGitHubRepoSearch', () => {
  test('maps repos with null installs (degraded fallback)', () => {
    const r = parseGitHubRepoSearch({
      items: [{ full_name: 'o/r', name: 'r', description: 'd' }],
    });
    expect(r[0]).toMatchObject({ id: 'o/r', source: 'o/r', installs: null, publisher: 'o' });
  });

  test('tolerates malformed payloads', () => {
    expect(parseGitHubRepoSearch({})).toEqual([]);
    expect(parseGitHubRepoSearch({ items: [{}] })).toEqual([]);
  });
});

describe('parseOpenGraph', () => {
  test('extracts og tags, decodes entities, tolerates attribute order', () => {
    const html = `
      <meta content="find-skills — vercel-labs/skills" property="og:title"/>
      <meta property="og:description" content="Helps &quot;discover&quot; skills"/>
      <meta property="og:image" content="https://www.skills.sh/x/opengraph-image?1"/>
      <meta property="og:type" content="article"/>`;
    expect(parseOpenGraph(html)).toEqual({
      title: 'find-skills — vercel-labs/skills',
      description: 'Helps "discover" skills',
      image: 'https://www.skills.sh/x/opengraph-image?1',
    });
  });

  test('returns empty object when no og tags present', () => {
    expect(parseOpenGraph('<html><head><title>nope</title></head></html>')).toEqual({});
  });
});
