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
 *
 * Markdown syntax is not the only place the two sides legally disagree. The
 * display pipeline also DECODES a narrow set of numeric character references —
 * six bytes on disk, one character on screen — and this file is a consumer of
 * that contract; `whitespace-char-ref.ts` owns which refs are in it.
 */

import { decodeInlineWhitespaceNumericCharRef } from '../markdown/whitespace-char-ref.ts';

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

/**
 * Emphasis, strong, code, strikethrough, escape, math — anywhere in a line.
 *
 * Only characters that are ALWAYS markup wherever they appear belong here, so
 * that skipping one can never cross something the quote actually contained.
 * `$` qualifies (`$$x^2$$` renders as its formula); `=`, `<` and `>` do not,
 * and each has its own narrower rule below — a lone `=` is prose (`A = B`), as
 * is a lone `<` or `>` (`if x > y`).
 */
const INLINE_SYNTAX = new Set(['*', '_', '`', '~', '\\', '$']);

/**
 * A highlight's delimiter: the `==` of `==marked==`.
 *
 * Two characters, never one. A lone `=` is ordinary prose (`A = B`, `=>`), and
 * making it skippable would let a match cross an equals sign the quote never
 * contained — the same hazard `IMAGE_BANG` below exists to avoid for `!`. A
 * setext underline is a whole line and is claimed earlier by
 * `INVISIBLE_RULE_LINE`, so it never reaches here.
 */
const HIGHLIGHT_DELIM = /^={2,}/;

/**
 * An autolink's brackets: the `<` and `>` of `<https://example.com>` or
 * `<name@example.com>`, which render as the bare address.
 *
 * Only the brackets are elastic — the address between them IS on screen and
 * must match. And only when they really do bracket an address: a bare `<` or
 * `>` is prose (`if x > y`), so neither is skippable on its own.
 */
const AUTOLINK = /^<(?:[A-Za-z][A-Za-z0-9+.-]*:[^<>\s]*|[^\s<>@]+@[^\s<>]+)>/;

/** Bounds the backward scan that pairs a `>` with its opening `<`. */
const AUTOLINK_WINDOW = 512;

/** The `<` at `i` opens an autolink, so the bracket alone is invisible. */
function opensAutolink(text: string, i: number): boolean {
  return AUTOLINK.test(text.slice(i, i + AUTOLINK_WINDOW));
}

/** The `>` at `i` closes an autolink opened within the scan window. */
function closesAutolink(text: string, i: number): boolean {
  const open = text.lastIndexOf('<', i);
  if (open < 0 || i - open > AUTOLINK_WINDOW) return false;
  return AUTOLINK.exec(text.slice(open, i + 1))?.[0].length === i + 1 - open;
}

/**
 * An HTML tag whose markup renders as nothing: `<u>`, `</u>`, `<Icon x="1" />`.
 *
 * Single-character elasticity cannot do this. `<u>under</u>` would skip the
 * `<`, then match the tag's own `u` against the content's `u` and desync from
 * there. The tag has to go as one run.
 *
 * The name is required to start with a letter, so `<https://example.com>` is
 * not a tag — its `:` ends the name and the pattern fails, leaving the autolink
 * to the single-character `<` / `>` rule above, which is what it needs.
 */
const HTML_TAG = /^<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^>]*?)?\/?>/;

/** Bounds the slice `HTML_TAG` runs on. */
const HTML_TAG_WINDOW = 512;

/**
 * The head of an image: the `!` of `![alt](src)` / `![alt][ref]`.
 *
 * Only ever elastic in front of a `[` — a bare `!` is ordinary prose and
 * skipping it would let a match drift across an exclamation mark.
 */
const IMAGE_BANG = /^!(?=\[)/;

/**
 * The head of a footnote reference: the `[^` of `[^1]`.
 *
 * `[` alone was already elastic, but the `^` behind it was read as content, so
 * a passage containing a footnote marker could not be matched.
 */
const FOOTNOTE_HEAD = /^\[\^/;

/**
 * The tail of a reference-style link or image: `][ref]` and `][]`.
 *
 * Sister to `LINK_TAIL` — a reference renders as its label alone, so the
 * bracketed reference behind it is invisible the same way `](target)` is.
 */
const REFERENCE_TAIL = /^\]\[[^\]]*\]/;

/**
 * The invisible head of an ALIASED wiki link: `[[page|` of `[[page|Alias]]`.
 *
 * An aliased link renders as the alias alone, so the target AND the pipe are
 * invisible — and unlike the brackets they are arbitrary content, so they have
 * to be skipped as one run rather than a character at a time. Unaliased links
 * need nothing here: their target IS what renders, so it matches directly.
 */
const WIKI_ALIAS_HEAD = /^\[\[[^\][|]*\|/;

/**
 * The heading fragment of a wiki link: the `#sec` of `[[page#sec]]`.
 *
 * The link renders as its page (or its alias), so the fragment is invisible.
 * Anchored to a following `]]` rather than matching any `#`, so an ordinary
 * `#tag` mid-sentence stays content — a tag's `#` IS on screen and quotes
 * carry it.
 */
const WIKI_ANCHOR_TAIL = /^#[^\][|]*(?=\]\])/;

/** Bounds the slice the bracket-construct patterns run on. */
const BRACKET_WINDOW = 512;

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

/**
 * Heading, blockquote, bullet, and ordered-list markers — line-leading only.
 *
 * A bullet's optional `[ ]` / `[x]` goes with it: a task item renders as a
 * checkbox widget, so the brackets carry no text a selection could contain.
 */
const BLOCK_MARKER = /^(?:#{1,6}[ \t]+|>[ \t]?|(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)/;

/** Widest block marker worth considering; bounds the slice the regex runs on. */
const BLOCK_MARKER_WINDOW = 32;

/**
 * Table cell boundaries render as the gap between cells, never as a character.
 * Elastic for the same reason a bullet's `- ` is: a selection crossing two
 * cells arrives with the cell texts run together.
 */
const TABLE_PIPE = '|';

/**
 * Source lines that render as no text whatsoever, matched whole.
 *
 * Unlike a bullet's `- `, these are not a marker in front of content — the
 * entire line is invisible to anyone selecting rendered text, so skipping one
 * character at a time cannot get past them. A code fence is the case that
 * reached users: the delimiter's backticks were already elastic, but the info
 * string after them (```` ```ts ````) was not, so every selection that crossed
 * into or out of a language-tagged code block failed to anchor.
 *
 * Each alternative must match to end-of-line, so a line carrying real content
 * can never be swallowed: `***bold***` is not a thematic break, and a paragraph
 * opening `-- ` is not a table rule.
 */
const INVISIBLE_LINE =
  // Fenced-code delimiter: opener plus its info string, or the closer.
  /^(?:`{3,}[^`\n]*|~{3,}[^\n]*)$/;

/** Thematic break, setext heading underline, and table delimiter row. */
const INVISIBLE_RULE_LINE = /^(?:(?:[-*_][ \t]*){3,}|=+[ \t]*|[|\-: \t]*-[|\-: \t]*)$/;

/**
 * Longest line still worth testing against the whole-line patterns. Past this a
 * line is prose or minified data, not a fence or a rule, and the scan should not
 * pay for the slice.
 */
const INVISIBLE_LINE_WINDOW = 1024;

/**
 * Length of the whole-line construct starting at `i`, or 0 when the line
 * renders as something. Caller must have established that `i` is a line start.
 */
function invisibleLineRunAt(text: string, i: number): number {
  const brk = text.indexOf('\n', i);
  let end = brk === -1 ? text.length : brk;
  // A CRLF document leaves the `\r` on this slice, and none of the rule
  // patterns' character classes admit it — `$` could never match, so a
  // thematic break or table rule stayed non-elastic on Windows line endings.
  // Trimmed rather than admitted, so the run stops before the `\r` and the
  // whitespace rule consumes it like any other space.
  if (end > i && text[end - 1] === '\r') end -= 1;
  if (end - i > INVISIBLE_LINE_WINDOW) return 0;
  const line = text.slice(i, end);
  if (line.length === 0) return 0;
  if (!INVISIBLE_LINE.test(line) && !INVISIBLE_RULE_LINE.test(line)) return 0;
  return line.length;
}

/**
 * One numeric character reference.
 *
 * LOCKSTEP: the PATTERN BODY is identical to `NUMERIC_CHAR_REF_TOKEN` in
 * `whitespace-char-ref.ts` and `NUMERIC_CHAR_REF_TOKEN_RE` in
 * `to-markdown-handlers.ts`; change all three together or they classify
 * different ref sets. The FLAG differs on purpose and must not be "corrected"
 * to match: sticky (`/y`) anchors `exec` at `lastIndex`, which is what makes
 * the run scan below positional. With `/g` the same call would happily return
 * a match from further down the text, and the scan would report a run that
 * does not start where it was asked to look.
 *
 * This file owns the scan; `whitespace-char-ref.ts` owns which refs decode and
 * to what, via `decodeInlineWhitespaceNumericCharRef`.
 */
const NUMERIC_CHAR_REF_TOKEN = /&#(?:x[0-9A-Fa-f]+|X[0-9A-Fa-f]+|[0-9]+);/y;

/**
 * A run of back-to-back numeric character references the display pipeline
 * decodes, and the characters it shows in their place — or null when `i` opens
 * no such run.
 *
 * The byte-fidelity serializer mints these to hold a phrasing-boundary space or
 * tab across re-parse (CommonMark §6.4), so an ordinary space typed just inside
 * `**…**` reaches disk as `&#x20;`. Nobody types the entity, which is why this
 * reaches ordinary documents.
 *
 * Deliberately NOT a `syntaxRunAt` entry. A syntax run means "renders as
 * nothing, skip it" — true of a space or tab, false of `&#xA0;`: NBSP is not
 * whitespace to `isSpace`, so the other side carries it as content and the run
 * has to be decoded and compared rather than skipped. Refs outside the decoded
 * set (`&amp;`, `&hellip;`, `&#x2014;`) reach the screen as their own bytes and
 * must stay content, so they get null and match literally as they always did.
 */
function renderedCharRefRunAt(
  text: string,
  i: number,
): { length: number; rendered: string } | null {
  if (text[i] !== '&') return null;
  let end = i;
  let rendered = '';
  for (;;) {
    NUMERIC_CHAR_REF_TOKEN.lastIndex = end;
    const token = NUMERIC_CHAR_REF_TOKEN.exec(text)?.[0];
    if (token === undefined) break;
    const char = decodeInlineWhitespaceNumericCharRef(token);
    if (char === null) break;
    rendered += char;
    end += token.length;
  }
  return end === i ? null : { length: end - i, rendered };
}

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
  // Whole-line constructs first: a fence and a thematic break both open with a
  // character that is also inline syntax, and consuming it one at a time leaves
  // the rest of the line (`ts`, `- - -`) looking like content.
  if (isLineStart(text, i)) {
    const line = invisibleLineRunAt(text, i);
    if (line > 0) return line;
  }
  if (ch === TABLE_PIPE) return 1;
  // Multi-character runs before the single-character sets: `<u>` opens with a
  // character that is also inline syntax, and consuming it alone leaves the tag
  // name looking like content.
  if (ch === '<') {
    const tag = HTML_TAG.exec(text.slice(i, i + HTML_TAG_WINDOW))?.[0].length;
    if (tag !== undefined) return tag;
    // Just the bracket — the address behind it renders and has to match.
    return opensAutolink(text, i) ? 1 : 0;
  }
  // Both fall through when they are not what they might have been, so a
  // line-leading `>` still reaches the blockquote rule at the end.
  if (ch === '>' && closesAutolink(text, i)) return 1;
  if (ch === '=') {
    const highlight = HIGHLIGHT_DELIM.exec(text.slice(i, i + 3))?.[0].length;
    if (highlight !== undefined) return highlight;
  }
  if (ch === '!') return IMAGE_BANG.test(text.slice(i, i + 2)) ? 1 : 0;
  if (INLINE_SYNTAX.has(ch)) return 1;
  // `[label](target)`, `[[target]]`, and `[^1]` all render as their label alone
  // (or as nothing), so the brackets, the `](target)` tail, and an aliased wiki
  // link's `target|` head are invisible to a caller working from rendered text.
  if (ch === '[') {
    const window = text.slice(i, i + BRACKET_WINDOW);
    const alias = WIKI_ALIAS_HEAD.exec(window)?.[0].length;
    if (alias !== undefined) return alias;
    if (FOOTNOTE_HEAD.test(window)) return 2;
    return 1;
  }
  if (ch === '#') {
    const anchor = WIKI_ANCHOR_TAIL.exec(text.slice(i, i + BRACKET_WINDOW))?.[0].length;
    // Falls through when it is not a wiki-link fragment, so a line-leading `#`
    // still reaches the heading rule at the end of this function.
    if (anchor !== undefined) return anchor;
  }
  if (ch === ']') {
    // Wiki-link close first: `]]` is never the start of a link tail.
    if (text[i + 1] === ']') return 2;
    const window = text.slice(i, i + Math.max(LINK_TAIL_WINDOW, BRACKET_WINDOW));
    const inline = LINK_TAIL.exec(window)?.[0].length;
    if (inline !== undefined) return inline;
    const reference = REFERENCE_TAIL.exec(window)?.[0].length;
    if (reference !== undefined) return reference;
    // A plain closer — the `]` of `[^1]`. Symmetric with the bare `[` above,
    // which has always been elastic; without it a footnote marker could not be
    // crossed even once its `[^` head was skippable.
    return 1;
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
    // …unless the caller's own text opens with that character, in which case it
    // is content to them and the loop will match it literally. Inline HTML that
    // survives into rendered text is the case: a quote of `<div>` must still be
    // able to start on the `<` that `HTML_TAG` would otherwise call syntax.
    if (
      syntaxInHaystack &&
      first !== needle[0] &&
      (syntaxRunAt(haystack, start) > 0 || renderedCharRefRunAt(haystack, start) !== null)
    ) {
      continue;
    }

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
      // A run of character references the markdown side spends on a character
      // the other side simply has. Consume the run there, and what it renders
      // here: a decoded space or tab asks nothing (whitespace is already
      // elastic both ways), while a decoded NBSP is content the other side has
      // to supply — its own whitespace in front of it stays elastic.
      const decoded = syntaxInHaystack
        ? renderedCharRefRunAt(haystack, hi)
        : renderedCharRefRunAt(needle, ni);
      if (decoded !== null) {
        const other = syntaxInHaystack ? needle : haystack;
        let oi = syntaxInHaystack ? ni : hi;
        let supplied = true;
        for (const ch of decoded.rendered) {
          if (isSpace(ch)) continue;
          while (oi < other.length && isSpace(other[oi] as string)) oi += 1;
          if (other[oi] !== ch) {
            supplied = false;
            break;
          }
          oi += 1;
        }
        if (!supplied) break;
        if (syntaxInHaystack) {
          hi += decoded.length;
          ni = oi;
        } else {
          ni += decoded.length;
          hi = oi;
        }
        continue;
      }
      break;
    }
    // Whitespace left over in the needle once the haystack is exhausted. The
    // loop above can only skip it while there is still haystack to compare
    // against, so a needle ending in whitespace never completed at the very end
    // of the text — even though whitespace is elastic everywhere else.
    //
    // A comment on a document's LAST passage is the case that reached users.
    // Rendered text carries no trailing newline, while a stored suffix that ran
    // off the end of the markdown body is exactly "\n" — so `prefix + suffix`
    // matched (its "\n" was skipped mid-haystack) while `prefix + quote +
    // suffix` did not, and the deletion probe in `findRangeInIndex` read the
    // passage as deleted where it stood. The comment stayed `anchored`
    // server-side,
    // where the body does end in a newline, and silently lost its highlight.
    while (ni < needle.length && isSpace(needle[ni] as string)) ni += 1;
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

/**
 * How well the words around a candidate match the words captured around the
 * passage when the comment was written — the score that picks WHICH occurrence
 * of a repeated quote was meant.
 *
 * Shared by both sides deliberately. The client scores against rendered editor
 * text and the server against the markdown body, and for a while each kept its
 * own byte-exact copy of the comparison. Byte-exact is the one thing it cannot
 * be: the captured context joins blocks with a single `\n`, while the text
 * being scored separates them with `\n\n`, `- `, `> `, `#`. Every candidate
 * therefore scored zero the moment the context reached past its own block, the
 * ranking went inert, and the caller silently fell back to the first hit — so a
 * comment on the second of several identical list items anchored to the first.
 * Two copies also meant fixing one and leaving the other, which is how the
 * client and server came to disagree about the same thread.
 *
 * Whitespace is elastic on both sides, and markdown syntax on whichever side
 * carries it (`syntaxIn`) — the same tolerances {@link findAllPassages} applies
 * when locating the passage in the first place. Ranking only: the score orders
 * candidates and never moves a boundary, so condensing is safe here in a way it
 * would not be for a match.
 */
export interface ContextMatchOptions {
  /** `'haystack'` when `text` is markdown; `'none'` when it is rendered text. */
  readonly syntaxIn: 'haystack' | 'none';
  /**
   * Whether the stored `prefix`/`suffix` themselves carry markdown syntax —
   * independent of the haystack, because the two sides come from different
   * places. A STORED anchor's context is a slice of the markdown body, so it
   * arrives with `## `, `1. `, `**` in it; the context a client captures around
   * a live selection is rendered text and has none.
   *
   * Condensing a markdown context as though it were rendered was a silent
   * scoring collapse, not a rounding error: a 32-character window reaches past
   * its own block in ordinary prose, so it almost always contains a heading or
   * list marker, and one such character at the seam takes the common-run length
   * to zero — `## Steps\n\n1. ` condenses to `##Steps1.` against a rendered
   * `…Steps`, sharing nothing at the end. Every candidate scored 0, the
   * evidence floor could never be met, and re-find fell through to the
   * exact-literal bracket recovery for anchors that should have resolved on
   * their quote. The visible symptom was a highlight vanishing when text NEAR
   * the passage — inside the stored context window, but not inside the quote —
   * was edited.
   */
  readonly syntaxInContext?: boolean;
}

/**
 * Text either side of a candidate worth condensing, as a multiple of the
 * context being matched. Generous because markdown spends characters that
 * render as nothing, so the same words occupy more of the body than of the
 * editor; bounded so a long document does not pay for the whole of itself on
 * every candidate.
 */
const CONTEXT_WINDOW_FACTOR = 8;
const CONTEXT_WINDOW_FLOOR = 64;

/** `text[from, to)` with whitespace — and optionally markdown syntax — removed. */
function condense(text: string, from: number, to: number, syntax: boolean): string {
  let out = '';
  let i = Math.max(0, from);
  const end = Math.min(text.length, to);
  while (i < end) {
    const ch = text[i] as string;
    if (isSpace(ch)) {
      i += 1;
      continue;
    }
    if (syntax) {
      const run = syntaxRunAt(text, i);
      if (run > 0) {
        i += run;
        continue;
      }
      const decoded = renderedCharRefRunAt(text, i);
      if (decoded !== null) {
        // Whitespace is dropped from both sides here, so a decoded space adds
        // nothing; an NBSP is content and has to survive on this side exactly
        // as it does on the rendered one, or the two condensations disagree.
        for (const ch of decoded.rendered) {
          if (!isSpace(ch)) out += ch;
        }
        i += decoded.length;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

function commonSuffixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
  return i;
}

function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}

export function contextMatchScore(
  text: string,
  span: { readonly start: number; readonly end: number },
  context: { readonly prefix?: string; readonly suffix?: string },
  { syntaxIn, syntaxInContext = false }: ContextMatchOptions,
): number {
  const prefix = context.prefix ?? '';
  const suffix = context.suffix ?? '';
  const syntax = syntaxIn === 'haystack';
  let score = 0;
  if (prefix.length > 0) {
    const window = prefix.length * CONTEXT_WINDOW_FACTOR + CONTEXT_WINDOW_FLOOR;
    score += commonSuffixLen(
      condense(prefix, 0, prefix.length, syntaxInContext),
      condense(text, span.start - window, span.start, syntax),
    );
  }
  if (suffix.length > 0) {
    const window = suffix.length * CONTEXT_WINDOW_FACTOR + CONTEXT_WINDOW_FLOOR;
    score += commonPrefixLen(
      condense(suffix, 0, suffix.length, syntaxInContext),
      condense(text, span.end, span.end + window, syntax),
    );
  }
  return score;
}

/**
 * The least context agreement a re-find may accept a quote hit on, in the
 * condensed characters {@link contextMatchScore} counts. Zero when too little
 * context is stored to demand anything (a quote hugging both document edges).
 *
 * This is what stands between a comment and an impostor. Deleting a commented
 * passage while an identical phrase survives elsewhere leaves the survivor as a
 * lone, clean hit of the quote — and a re-find that accepts a lone hit
 * unexamined re-anchors the comment onto words nobody commented on, with the
 * stored context in open disagreement. Any acceptance must therefore show a
 * TRACE of the recorded neighbourhood.
 *
 * A floor, not a match requirement: the surroundings may legitimately have been
 * edited, so it asks for a fragment, well under the stored context's length.
 * Above zero because unrelated locations share stray seam characters — a
 * period, a closing word — and a gate those satisfy is no gate. The cost is
 * deliberate and documented: a passage MOVED somewhere entirely new fails the
 * floor and orphans (its old neighbours, left behind and now adjacent, read as
 * a deletion) — "exact-match-or-orphan, never guess" is the contract, and
 * re-placing an orphan is one click.
 */
export function contextEvidenceFloor(
  context: {
    readonly prefix?: string;
    readonly suffix?: string;
  },
  { syntaxInContext = false }: { readonly syntaxInContext?: boolean } = {},
): number {
  const MAX_FLOOR = 8;
  // Condensed the same way `contextMatchScore` condenses this context, or the
  // floor asks for more agreement than the score can ever report — a context
  // that is mostly markers would demand characters scoring has already dropped.
  const available =
    condense(context.prefix ?? '', 0, Number.POSITIVE_INFINITY, syntaxInContext).length +
    condense(context.suffix ?? '', 0, Number.POSITIVE_INFINITY, syntaxInContext).length;
  return Math.min(MAX_FLOOR, available);
}

/**
 * The longest a passage may become when recovered from the context brackets
 * still surrounding it.
 *
 * Editing inside a commented passage is normal ("needs space" → "needs more
 * space"); replacing whole paragraphs between the same two boundaries is not,
 * and silently swallowing them would attach the comment to text nobody pointed
 * at. Generous but finite: past this, treat it as a replacement and orphan.
 *
 * Shared by both recovery paths — the editor's, over rendered text, and the
 * server's, over the markdown body. Those search different substrates and so
 * cannot share an implementation, but they must agree on this ceiling exactly:
 * a passage that recovers on one side and orphans on the other leaves a comment
 * highlighted against text the other half has already given up on. It lived as
 * two copies of two constants under a drift warning, which is the arrangement
 * that had already let `contextMatchScore` diverge — fixed on one side, silently
 * stale on the other — so the policy is a function here rather than a number
 * each side re-applies.
 */
export function rewriteCeiling(quoteLength: number): number {
  const MAX_GROWTH = 4;
  const GROWTH_FLOOR = 64;
  return Math.max(quoteLength * MAX_GROWTH, quoteLength + GROWTH_FLOOR);
}
