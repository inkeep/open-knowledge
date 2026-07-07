import { afterEach, describe, expect, test } from 'bun:test';
import {
  __resetPreviewCacheForTests,
  __testing_getCacheSize,
  countMatches,
  PREVIEW_CACHE_LIMIT,
} from './okignore-preview';

afterEach(() => {
  __resetPreviewCacheForTests();
});

describe('okignore-preview — countMatches', () => {
  test('exact path match returns 1', () => {
    expect(countMatches('drafts/foo.md', ['drafts/foo.md', 'keep.md'])).toBe(1);
  });

  test('directory pattern matches all descendants', () => {
    expect(
      countMatches('drafts/', ['drafts/foo.md', 'drafts/nested/bar.md', 'index.md', 'keep.md']),
    ).toBe(2);
  });

  test('glob pattern matches by extension', () => {
    expect(countMatches('*.md', ['foo.md', 'nested/bar.md', 'image.png'])).toBe(2);
  });

  test('returns 0 for a pattern with no matches', () => {
    expect(countMatches('zzz/never.md', ['foo.md', 'bar.md'])).toBe(0);
  });

  test('returns 0 for an empty pattern', () => {
    expect(countMatches('', ['foo.md', 'bar.md'])).toBe(0);
  });

  test('returns 0 for a whitespace-only pattern', () => {
    expect(countMatches('   ', ['foo.md', 'bar.md'])).toBe(0);
  });

  test('returns 0 for a comment-only pattern', () => {
    expect(countMatches('# ignored', ['foo.md', 'bar.md'])).toBe(0);
  });

  test('returns 0 for a lone-bang pattern', () => {
    // negation alone has no anchor to negate, so nothing is ignored.
    expect(countMatches('!keep.md', ['keep.md', 'foo.md'])).toBe(0);
  });

  test('returns 0 for an empty file list', () => {
    expect(countMatches('drafts/', [])).toBe(0);
  });

  test('trims pattern before keying the cache (whitespace variants share a slot)', () => {
    countMatches('drafts/', ['drafts/foo.md']);
    const sizeAfterFirst = __testing_getCacheSize();
    countMatches('  drafts/  ', ['drafts/foo.md']);
    expect(__testing_getCacheSize()).toBe(sizeAfterFirst);
  });

  test('different patterns occupy distinct cache slots', () => {
    countMatches('drafts/', ['drafts/foo.md']);
    countMatches('*.tmp', ['drafts/foo.md']);
    expect(__testing_getCacheSize()).toBe(2);
  });

  test('repeated calls with the same pattern reuse the cached Ignore instance', () => {
    countMatches('drafts/', ['drafts/foo.md']);
    countMatches('drafts/', ['drafts/foo.md', 'drafts/bar.md']);
    countMatches('drafts/', ['index.md']);
    expect(__testing_getCacheSize()).toBe(1);
  });

  test('cache is bounded — exceeding the limit evicts oldest entries', () => {
    for (let i = 0; i < PREVIEW_CACHE_LIMIT + 5; i++) {
      countMatches(`unique-pattern-${i}`, ['foo.md']);
    }
    expect(__testing_getCacheSize()).toBeLessThanOrEqual(PREVIEW_CACHE_LIMIT);
  });

  test('counts assets in the file list (not just .md/.mdx)', () => {
    expect(
      countMatches('images/', ['images/diagram.png', 'images/screenshot.jpg', 'index.md']),
    ).toBe(2);
  });

  test('handles paths with spaces and unicode', () => {
    expect(countMatches('drafts/', ['drafts/My Note.md', 'drafts/résumé.md'])).toBe(2);
  });

  test('does not mutate the input file list', () => {
    const list: string[] = ['drafts/foo.md', 'keep.md'];
    const before = [...list];
    countMatches('drafts/', list);
    expect(list).toEqual(before);
  });

  test('returns 0 on a malformed-looking pattern (npm:ignore does NOT throw)', () => {
    // Trailing backslash and unmatched bracket are heuristic-warning cases —
    // the library tolerates them silently, so countMatches should not throw.
    expect(() => countMatches('foo\\', ['foo.md'])).not.toThrow();
    expect(() => countMatches('[unclosed', ['foo.md'])).not.toThrow();
  });

  test('exact-anchored pattern only matches at root', () => {
    expect(countMatches('/drafts.md', ['drafts.md', 'nested/drafts.md'])).toBe(1);
  });
});

describe('okignore-preview — cache reset', () => {
  test('__resetPreviewCacheForTests clears the cache', () => {
    countMatches('drafts/', ['foo.md']);
    expect(__testing_getCacheSize()).toBeGreaterThan(0);
    __resetPreviewCacheForTests();
    expect(__testing_getCacheSize()).toBe(0);
  });
});
