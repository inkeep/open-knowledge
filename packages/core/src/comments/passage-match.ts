import { decodeInlineWhitespaceNumericCharRef } from '../markdown/whitespace-char-ref.ts';

export interface PassageMatch {
  readonly start: number;
  readonly end: number;
}

export interface PassageMatchOptions {
  readonly syntaxIn: 'haystack' | 'needle';
}

const INLINE_SYNTAX = new Set(['*', '_', '`', '~', '\\', '$']);

const HIGHLIGHT_DELIM = /^={2,}/;

const AUTOLINK = /^<(?:[A-Za-z][A-Za-z0-9+.-]*:[^<>\s]*|[^\s<>@]+@[^\s<>]+)>/;

const AUTOLINK_WINDOW = 512;

function opensAutolink(text: string, i: number): boolean {
  return AUTOLINK.test(text.slice(i, i + AUTOLINK_WINDOW));
}

function closesAutolink(text: string, i: number): boolean {
  const open = text.lastIndexOf('<', i);
  if (open < 0 || i - open > AUTOLINK_WINDOW) return false;
  return AUTOLINK.exec(text.slice(open, i + 1))?.[0].length === i + 1 - open;
}

const HTML_TAG = /^<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^>]*?)?\/?>/;

const HTML_TAG_WINDOW = 512;

const IMAGE_BANG = /^!(?=\[)/;

const FOOTNOTE_HEAD = /^\[\^/;

const REFERENCE_TAIL = /^\]\[[^\]]*\]/;

const WIKI_ALIAS_HEAD = /^\[\[[^\][|]*\|/;

const WIKI_ANCHOR_TAIL = /^#[^\][|]*(?=\]\])/;

const BRACKET_WINDOW = 512;

const LINK_TAIL = /^\]\([^)]*\)/;

const LINK_TAIL_WINDOW = 512;

const BLOCK_MARKER = /^(?:#{1,6}[ \t]+|>[ \t]?|(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)/;

const BLOCK_MARKER_WINDOW = 32;

const TABLE_PIPE = '|';

const INVISIBLE_LINE = /^(?:`{3,}[^`\n]*|~{3,}[^\n]*)$/;

const INVISIBLE_RULE_LINE = /^(?:(?:[-*_][ \t]*){3,}|=+[ \t]*|[|\-: \t]*-[|\-: \t]*)$/;

const INVISIBLE_LINE_WINDOW = 1024;

function invisibleLineRunAt(text: string, i: number): number {
  const brk = text.indexOf('\n', i);
  let end = brk === -1 ? text.length : brk;
  if (end > i && text[end - 1] === '\r') end -= 1;
  if (end - i > INVISIBLE_LINE_WINDOW) return 0;
  const line = text.slice(i, end);
  if (line.length === 0) return 0;
  if (!INVISIBLE_LINE.test(line) && !INVISIBLE_RULE_LINE.test(line)) return 0;
  return line.length;
}

const NUMERIC_CHAR_REF_TOKEN = /&#(?:x[0-9A-Fa-f]+|X[0-9A-Fa-f]+|[0-9]+);/y;

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

function isLineStart(text: string, i: number): boolean {
  for (let k = i - 1; k >= 0; k -= 1) {
    const ch = text[k];
    if (ch === '\n') return true;
    if (ch !== ' ' && ch !== '\t') return false;
  }
  return true;
}

function syntaxRunAt(text: string, i: number): number {
  const ch = text[i];
  if (ch === undefined) return 0;
  if (isLineStart(text, i)) {
    const line = invisibleLineRunAt(text, i);
    if (line > 0) return line;
  }
  if (ch === TABLE_PIPE) return 1;
  if (ch === '<') {
    const tag = HTML_TAG.exec(text.slice(i, i + HTML_TAG_WINDOW))?.[0].length;
    if (tag !== undefined) return tag;
    return opensAutolink(text, i) ? 1 : 0;
  }
  if (ch === '>' && closesAutolink(text, i)) return 1;
  if (ch === '=') {
    const highlight = HIGHLIGHT_DELIM.exec(text.slice(i, i + 3))?.[0].length;
    if (highlight !== undefined) return highlight;
  }
  if (ch === '!') return IMAGE_BANG.test(text.slice(i, i + 2)) ? 1 : 0;
  if (INLINE_SYNTAX.has(ch)) return 1;
  if (ch === '[') {
    const window = text.slice(i, i + BRACKET_WINDOW);
    const alias = WIKI_ALIAS_HEAD.exec(window)?.[0].length;
    if (alias !== undefined) return alias;
    if (FOOTNOTE_HEAD.test(window)) return 2;
    return 1;
  }
  if (ch === '#') {
    const anchor = WIKI_ANCHOR_TAIL.exec(text.slice(i, i + BRACKET_WINDOW))?.[0].length;
    if (anchor !== undefined) return anchor;
  }
  if (ch === ']') {
    if (text[i + 1] === ']') return 2;
    const window = text.slice(i, i + Math.max(LINK_TAIL_WINDOW, BRACKET_WINDOW));
    const inline = LINK_TAIL.exec(window)?.[0].length;
    if (inline !== undefined) return inline;
    const reference = REFERENCE_TAIL.exec(window)?.[0].length;
    if (reference !== undefined) return reference;
    return 1;
  }
  if (!isLineStart(text, i)) return 0;
  return BLOCK_MARKER.exec(text.slice(i, i + BLOCK_MARKER_WINDOW))?.[0].length ?? 0;
}

export function findAllPassages(
  haystack: string,
  needle: string,
  { syntaxIn }: PassageMatchOptions,
): PassageMatch[] {
  const out: PassageMatch[] = [];
  if (needle.length === 0) return out;
  const syntaxInHaystack = syntaxIn === 'haystack';

  for (let start = 0; start < haystack.length; start += 1) {
    const first = haystack[start];
    if (first === undefined || isSpace(first)) continue;
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
    while (ni < needle.length && isSpace(needle[ni] as string)) ni += 1;
    if (ni === needle.length) out.push({ start, end: hi });
  }
  return out;
}

export function findPassage(
  haystack: string,
  needle: string,
  options: PassageMatchOptions,
): PassageMatch | null {
  return findAllPassages(haystack, needle, options)[0] ?? null;
}

export interface ContextMatchOptions {
  readonly syntaxIn: 'haystack' | 'none';
  readonly syntaxInContext?: boolean;
}

const CONTEXT_WINDOW_FACTOR = 8;
const CONTEXT_WINDOW_FLOOR = 64;

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

export function contextEvidenceFloor(
  context: {
    readonly prefix?: string;
    readonly suffix?: string;
  },
  { syntaxInContext = false }: { readonly syntaxInContext?: boolean } = {},
): number {
  const MAX_FLOOR = 8;
  const available =
    condense(context.prefix ?? '', 0, Number.POSITIVE_INFINITY, syntaxInContext).length +
    condense(context.suffix ?? '', 0, Number.POSITIVE_INFINITY, syntaxInContext).length;
  return Math.min(MAX_FLOOR, available);
}

export function rewriteCeiling(quoteLength: number): number {
  const MAX_GROWTH = 4;
  const GROWTH_FLOOR = 64;
  return Math.max(quoteLength * MAX_GROWTH, quoteLength + GROWTH_FLOOR);
}
