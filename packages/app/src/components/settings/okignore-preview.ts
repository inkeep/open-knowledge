import ignore, { type Ignore } from 'ignore';

export const PREVIEW_CACHE_LIMIT = 256;

const cache = new Map<string, Ignore>();

function getOrCreate(trimmed: string): Ignore {
  const existing = cache.get(trimmed);
  if (existing) {
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

export function __resetPreviewCacheForTests(): void {
  cache.clear();
}

export function __testing_getCacheSize(): number {
  return cache.size;
}
