export function canonicalPathKey(path: string): string {
  return path.normalize('NFC');
}

export function indexPathsByCanonicalKey(paths: Iterable<string>): Map<string, string> {
  const index = new Map<string, string>();
  for (const path of paths) {
    const key = canonicalPathKey(path);
    if (!index.has(key)) index.set(key, path);
  }
  return index;
}

const canonicalIndexCache = new WeakMap<ReadonlySet<string>, ReadonlyMap<string, string>>();

function queryNeedsCanonicalIndex(query: string): boolean {
  for (const char of query) {
    const codePoint = char.codePointAt(0);
    if (codePoint !== undefined && codePoint > 0x7f) return true;
  }
  return false;
}

export function matchStoredPath(paths: ReadonlySet<string>, query: string): string | null {
  if (paths.has(query)) return query;
  if (!queryNeedsCanonicalIndex(query)) return null;
  const key = canonicalPathKey(query);
  for (const path of paths) {
    if (canonicalPathKey(path) === key) return path;
  }
  return null;
}

export function resolveStoredPath(paths: ReadonlySet<string>, query: string): string | null {
  if (paths.has(query)) return query;
  if (!queryNeedsCanonicalIndex(query)) return null;
  let index = canonicalIndexCache.get(paths);
  if (!index) {
    index = indexPathsByCanonicalKey(paths);
    canonicalIndexCache.set(paths, index);
  }
  return index.get(canonicalPathKey(query)) ?? null;
}
