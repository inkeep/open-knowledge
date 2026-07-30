/**
 * Locate a passage across the markdown / rendered-text boundary.
 *
 * A comment anchor is measured against a document's markdown BODY, but the
 * editor only ever knows RENDERED text. The same passage differs between the
 * two by exactly the characters markdown spends on formatting: `**bold**`
 * renders as `bold`, a list item renders without its `- `, a heading without
 * its `##`. Converting one side to the other is not reliable — serializing a
 * partial ProseMirror selection fabricates the block marker of whatever block
 * the selection happens to sit in, so a pick starting mid-bullet comes back as
 * `- 3 tbsp peanut butter` when the source line reads
 * `- **Peanut sauce:** 3 tbsp peanut butter`.
 *
 * So instead of converting, match the characters that survive rendering and
 * treat markdown syntax as elastic on whichever side carries it. Every other
 * character must still match, in order: this is not a fuzzy match and cannot
 * land on different words.
 */

/** A located passage as `[start, end)` offsets into the haystack. */
export interface PassageMatch {
  readonly start: number;
  readonly end: number;
}

export interface PassageMatchOptions {
  /**
   * Which side is the markdown one, and may therefore carry syntax the other
   * side lacks. Searching a markdown body for rendered text is `'haystack'`;
   * searching rendered editor text for a stored markdown quote is `'needle'`.
   */
  readonly syntaxIn: 'haystack' | 'needle';
}

/** Emphasis, strong, code, strikethrough, escape — anywhere in a line. */
const INLINE_SYNTAX = new Set(['*', '_', '`', '~', '\\']);

/**
 * The tail of an inline link or image: `](target)`.
 *
 * A link renders as its label alone, so everything from the closing bracket
 * through the closing paren is invisible to anyone selecting rendered text —
 * and unlike `*` or `` ` ``, it is a multi-character run that has to be skipped
 * whole. Missing this is why a passage containing any link could not be
 * matched at all, which in a linked wiki is most of the interesting passages.
 *
 * A target containing an unescaped `)` truncates here; that is rare enough to
 * accept, and it fails safe — the match simply doesn't happen.
 */
const LINK_TAIL = /^\]\([^)]*\)/;

/** Bounds the slice `LINK_TAIL` runs on. Generous — targets can be long URLs. */
const LINK_TAIL_WINDOW = 512;

/** Heading, blockquote, bullet, and ordered-list markers — line-leading only. */
const BLOCK_MARKER = /^(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d{1,9}[.)][ \t]+)/;

/** Widest block marker worth considering; bounds the slice the regex runs on. */
const BLOCK_MARKER_WINDOW = 32;

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

/** True when only indentation separates `i` from the start of its line. */
function isLineStart(text: string, i: number): boolean {
  for (let k = i - 1; k >= 0; k -= 1) {
    const ch = text[k];
    if (ch === '\n') return true;
    if (ch !== ' ' && ch !== '\t') return false;
  }
  return true;
}

/** Length of the markdown syntax run at `i`, or 0 when `i` is content. */
function syntaxRunAt(text: string, i: number): number {
  const ch = text[i];
  if (ch === undefined) return 0;
  if (INLINE_SYNTAX.has(ch)) return 1;
  // `[label](target)` and `[[target]]` both render as their label alone, so the
  // brackets and the whole `](target)` tail are invisible to a caller working
  // from rendered text.
  if (ch === '[') return 1;
  if (ch === ']') {
    // Wiki-link close first: `]]` is never the start of a link tail.
    if (text[i + 1] === ']') return 2;
    return LINK_TAIL.exec(text.slice(i, i + LINK_TAIL_WINDOW))?.[0].length ?? 0;
  }
  if (!isLineStart(text, i)) return 0;
  return BLOCK_MARKER.exec(text.slice(i, i + BLOCK_MARKER_WINDOW))?.[0].length ?? 0;
}

/**
 * Every place `needle` occurs in `haystack`, in document order, allowing the
 * markdown side to carry extra syntax characters and both sides to disagree
 * about whitespace (a selection spanning blocks arrives with the blocks joined
 * differently than the `\n\n` in the source).
 */
export function findAllPassages(
  haystack: string,
  needle: string,
  { syntaxIn }: PassageMatchOptions,
): PassageMatch[] {
  const out: PassageMatch[] = [];
  if (needle.length === 0) return out;
  const syntaxInHaystack = syntaxIn === 'haystack';

  for (let start = 0; start < haystack.length; start += 1) {
    // A match never begins on a character the other side can't see, or the
    // reported range would open with syntax the caller never selected.
    const first = haystack[start];
    if (first === undefined || isSpace(first)) continue;
    if (syntaxInHaystack && syntaxRunAt(haystack, start) > 0) continue;

    let hi = start;
    let ni = 0;
    while (hi < haystack.length && ni < needle.length) {
      const hc = haystack[hi] as string;
      const nc = needle[ni] as string;
      if (hc === nc) {
        hi += 1;
        ni += 1;
        continue;
      }
      if (isSpace(nc)) {
        ni += 1;
        continue;
      }
      if (isSpace(hc)) {
        hi += 1;
        continue;
      }
      const run = syntaxInHaystack ? syntaxRunAt(haystack, hi) : syntaxRunAt(needle, ni);
      if (run > 0) {
        if (syntaxInHaystack) hi += run;
        else ni += run;
        continue;
      }
      break;
    }
    if (ni === needle.length) out.push({ start, end: hi });
  }
  return out;
}

/** First occurrence of `needle`, or null. See {@link findAllPassages}. */
export function findPassage(
  haystack: string,
  needle: string,
  options: PassageMatchOptions,
): PassageMatch | null {
  return findAllPassages(haystack, needle, options)[0] ?? null;
}
