/**
 * Per-row pattern preview — counts how many visible files a candidate
 * gitignore pattern would match. Browser-safe: `npm:ignore` is pure-JS.
 *
 * The visible-set caveat: matches are computed against the post-filter file
 * list `usePageList()` already exposes (gitignore + existing okignore are
 * applied server-side). A new pattern that targets a file already excluded
 * by another rule will report 0. The Settings UI surfaces this with the
 * "(some may already be hidden by other rules)" secondary label.
 *
 * Cache discipline: each unique trimmed pattern string gets one `Ignore`
 * instance. Re-typing the same pattern in another row is a free lookup.
 * A bounded cap evicts the oldest entry on overflow so a pathological
 * typing burst can't grow memory without bound.
 */

import ignore, { type Ignore } from 'ignore';

export const PREVIEW_CACHE_LIMIT = 256;

const cache = new Map<string, Ignore>();

function getOrCreate(trimmed: string): Ignore {
  const existing = cache.get(trimmed);
  if (existing) {
    // LRU touch: re-insert to move to the end of the iteration order.
    cache.delete(trimmed);
    cache.set(trimmed, existing);
    return existing;
  }
  const ig = ignore();
  ig.add(trimmed);
  cache.set(trimmed, ig);
  if (cache.size > PREVIEW_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return ig;
}

/**
 * Count files in `filePaths` that the given gitignore pattern would match.
 * Empty / whitespace / comment / lone-`!` patterns return 0 (no matches).
 * `npm:ignore` does not throw on malformed input; this never throws.
 */
export function countMatches(pattern: string, filePaths: ReadonlyArray<string>): number {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return 0;
  if (trimmed.startsWith('#')) return 0;
  const ig = getOrCreate(trimmed);
  let matches = 0;
  for (const path of filePaths) {
    if (path.length === 0) continue;
    if (ig.ignores(path)) matches += 1;
  }
  return matches;
}

/** Test-only escape hatches. Not exported through the package barrel. */
export function __resetPreviewCacheForTests(): void {
  cache.clear();
}

export function __testing_getCacheSize(): number {
  return cache.size;
}
