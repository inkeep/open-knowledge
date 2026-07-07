/**
 * Normalized-key index over an export's files.
 *
 * Notion distorts the same page's identity three independent ways: link targets
 * are percent-encoded (`Foo%20Bar`), filenames carry a trailing ` <32-hex-id>`,
 * and Notion strips punctuation (`* " / \ < > : | ? ( )`) from filenames while
 * keeping it in titles and link targets. So a link target string never equals
 * the filename byte-for-byte. `normalizeKey` folds all three away so matching is
 * by meaning; the index maps a key to the LIST of files that share it so
 * duplicate titles surface as ambiguous instead of being silently misresolved.
 */

// Punctuation Notion removes from exported filenames but keeps in titles/links.
const ILLEGAL_PUNCT = /[*"/\\<>:|?()]/g;
const DOC_EXT = /\.(md|mdx)$/i;
const TRAILING_ID = /\s+[0-9a-f]{32}$/i;

/**
 * Fold a filename, link target, or title down to a comparison key: percent-decode,
 * drop the doc extension, drop a trailing 32-hex Notion id, strip Notion-illegal
 * punctuation, collapse whitespace, casefold.
 */
export function normalizeKey(input: string): string {
  // Match on the last path segment — links may be `../dir/Page.md`. Split on both
  // separators so Windows backslash paths (from node:path.join) also reduce to the
  // basename.
  let v = input.split(/[\\/]/).pop() ?? input;
  try {
    v = decodeURIComponent(v);
  } catch {
    // Malformed percent-encoding: fall back to the raw segment.
  }
  v = v.replace(DOC_EXT, '');
  v = v.replace(TRAILING_ID, '');
  v = v.replace(ILLEGAL_PUNCT, '');
  v = v.replace(/\s+/g, ' ').trim().toLowerCase();
  return v;
}

/** Build a `normalizedKey -> file paths` index. Files are keyed by basename. */
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
  /** The single matching file path, or null when missing or ambiguous. */
  path: string | null;
  /** True when >1 file shares the key — caller must not guess. */
  ambiguous: boolean;
}

/** Resolve a link target or title to a single file, or null if missing/ambiguous. */
export function resolveKey(index: Map<string, string[]>, target: string): Resolution {
  const key = normalizeKey(target);
  const hits = key ? index.get(key) : undefined;
  if (!hits || hits.length === 0) return { path: null, ambiguous: false };
  if (hits.length > 1) return { path: null, ambiguous: true };
  return { path: hits[0] as string, ambiguous: false };
}
