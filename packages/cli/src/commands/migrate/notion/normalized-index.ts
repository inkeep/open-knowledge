const ILLEGAL_PUNCT = /[*"/\\<>:|?()]/g;
const DOC_EXT = /\.(md|mdx)$/i;
const TRAILING_ID = /\s+[0-9a-f]{32}$/i;

export function normalizeKey(input: string): string {
  let v = input.split(/[\\/]/).pop() ?? input;
  try {
    v = decodeURIComponent(v);
  } catch {}
  v = v.replace(DOC_EXT, '');
  v = v.replace(TRAILING_ID, '');
  v = v.replace(ILLEGAL_PUNCT, '');
  v = v.replace(/\s+/g, ' ').trim().toLowerCase();
  return v;
}

export function buildIndex(files: readonly string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const f of files) {
    const key = normalizeKey(f);
    if (!key) continue;
    const arr = map.get(key);
    if (arr) arr.push(f);
    else map.set(key, [f]);
  }
  return map;
}

export interface Resolution {
  path: string | null;
  ambiguous: boolean;
}

export function resolveKey(index: Map<string, string[]>, target: string): Resolution {
  const key = normalizeKey(target);
  const hits = key ? index.get(key) : undefined;
  if (!hits || hits.length === 0) return { path: null, ambiguous: false };
  if (hits.length > 1) return { path: null, ambiguous: true };
  return { path: hits[0] as string, ambiguous: false };
}
