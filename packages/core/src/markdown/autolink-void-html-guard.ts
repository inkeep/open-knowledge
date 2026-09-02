import type { Nodes, Root } from 'mdast';
import { visit } from 'unist-util-visit';
import { findFencedRegions, findInlineCodeRegions, isInsideFence } from './fence-regions.ts';

const GUARD_OPEN = '\uE000';
const GUARD_CLOSE = '\uE001';
const GUARD_COLON = '\uE002';
const GUARD_AT = '\uE003';
const GUARD_OPEN_BRACE = '\uE004';

const LITERAL_SENTINEL_ESCAPES: ReadonlyArray<readonly [string, string]> = [
  [GUARD_OPEN, '\uE005'],
  [GUARD_CLOSE, '\uE006'],
  [GUARD_COLON, '\uE007'],
  [GUARD_AT, '\uE008'],
  [GUARD_OPEN_BRACE, '\uE009'],
];
const HAS_LITERAL_SENTINEL_RE = /[\uE000-\uE004]/;
const HAS_ESCAPED_LITERAL_SENTINEL_RE = /[\uE005-\uE009]/;

export const R23_GUARD_SUBSTITUTIONS: ReadonlyArray<{ from: string; to: string }> = [
  { from: '<', to: GUARD_OPEN },
  { from: '>', to: GUARD_CLOSE },
  { from: ':', to: GUARD_COLON },
  { from: '@', to: GUARD_AT },
  { from: '{', to: GUARD_OPEN_BRACE },
];

export const R23_SENTINEL_ESCAPE_SUBSTITUTIONS: ReadonlyArray<{ from: string; to: string }> =
  LITERAL_SENTINEL_ESCAPES.map(([from, to]) => ({ from, to }));

const AUTOLINK_RE = /<([a-zA-Z][a-zA-Z0-9+.-]*:[^\s<>]+)>/g;

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

const HTML_CLOSE_TAG_RE = /<\/([a-z][a-z0-9]*)\s*>/g;

const LOWERCASE_HTML_TAG_RE = /<([a-z][a-z0-9]*)(\s[^>]*)?\/?>/g;

const LOWERCASE_JSX_CANONICAL_TAGS = new Set(['img', 'video', 'audio']);

const LOWERCASE_PAIRED_JSX_TAGS = new Set(['mark', 'u', 'ins']);

function countOpenersBefore(
  source: string,
  tag: string,
  offset: number,
  codeRegions: Array<[number, number]>,
): number {
  let count = 0;
  let from = 0;
  const needle = `<${tag}`;
  while (from < offset) {
    const at = source.indexOf(needle, from);
    if (at === -1 || at >= offset) break;
    from = at + needle.length;
    const after = source[at + needle.length];
    if (after !== undefined && after !== '>' && after !== '/' && !/\s/.test(after)) continue;
    if (isInsideFence(at, codeRegions)) continue;
    const gt = source.indexOf('>', at);
    if (gt !== -1 && source[gt - 1] === '/') continue;
    count++;
  }
  return count;
}

const UPPERCASE_CLOSE_TAG_INDEX_RE = /<\/([A-Z][A-Za-z0-9.]*)>/g;

function lowerBound(arr: number[], target: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function indexUppercaseCloseTagsByName(source: string): Map<string, number[]> {
  const index = new Map<string, number[]>();
  const re = new RegExp(UPPERCASE_CLOSE_TAG_INDEX_RE.source, 'g');
  let m = re.exec(source);
  while (m !== null) {
    const existing = index.get(m[1]);
    if (existing) existing.push(m.index);
    else index.set(m[1], [m.index]);
    m = re.exec(source);
  }
  return index;
}

function indexParagraphBreaks(source: string): number[] {
  const breaks: number[] = [];
  const re = /\n\s*\n/g;
  let m = re.exec(source);
  while (m !== null) {
    breaks.push(m.index);
    m = re.exec(source);
  }
  return breaks;
}

function indexGreaterThan(source: string): number[] {
  const positions: number[] = [];
  let i = source.indexOf('>');
  while (i !== -1) {
    positions.push(i);
    i = source.indexOf('>', i + 1);
  }
  return positions;
}

const ANGLE_DEST_SCAN_CAP = 1024;

function isAngleBracketDestinationOpen(offset: number, result: string): boolean {
  if (result[offset - 1] !== '(' || result[offset - 2] !== ']') return false;
  const labelEnd = offset - 2;
  let bs = 0;
  for (let j = labelEnd - 1; j >= 0 && result[j] === '\\'; j--) bs++;
  if (bs % 2 === 1) return false;

  let foundLabelStart = false;
  const scanFloor = Math.max(0, labelEnd - ANGLE_DEST_SCAN_CAP);
  for (let j = labelEnd - 1; j >= scanFloor; j--) {
    const ch = result[j];
    if (ch === '\n' || ch === '\r' || ch === '`') return false;
    if (ch !== '[' && ch !== ']') continue;
    let k = 0;
    for (let m = j - 1; m >= 0 && result[m] === '\\'; m--) k++;
    if (k % 2 === 1) continue;
    if (ch === ']') return false;
    if (result[j + 1] === '^') return false;
    if (result[j - 1] === ']') return false;
    foundLabelStart = true;
    break;
  }
  if (!foundLabelStart) return false;

  let sawWhitespace = false;
  let destClose = -1;
  const scanCeil = Math.min(result.length, offset + 1 + ANGLE_DEST_SCAN_CAP);
  for (let j = offset + 1; j < scanCeil; j++) {
    const ch = result[j];
    if (ch === '>') {
      destClose = j;
      break;
    }
    if (ch === '<' || ch === '\\' || ch === '\n' || ch === '\r') return false;
    if (
      ch === GUARD_OPEN ||
      ch === GUARD_CLOSE ||
      ch === GUARD_COLON ||
      ch === GUARD_AT ||
      ch === GUARD_OPEN_BRACE
    ) {
      return false;
    }
    if (ch === ' ' || ch === '\t') sawWhitespace = true;
  }
  if (destClose === -1 || !sawWhitespace) return false;
  return result[destClose + 1] === ')';
}

function isSelfClosingTagAt(
  offset: number,
  result: string,
  greaterThanOffsets: number[],
  paragraphBreaks: number[],
): boolean {
  const gtIdx = lowerBound(greaterThanOffsets, offset);
  if (gtIdx >= greaterThanOffsets.length) return false;
  const tagClose = greaterThanOffsets[gtIdx];
  const pbIdx = lowerBound(paragraphBreaks, offset);
  const nextBlankLine = pbIdx < paragraphBreaks.length ? paragraphBreaks[pbIdx] : result.length;
  if (tagClose >= nextBlankLine) return false;
  return result[tagClose - 1] === '/';
}

function indexUppercaseTagSpans(source: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const TAG_START_RE = /<\/?([A-Z][A-Za-z0-9.]*)/g;
  for (const m of source.matchAll(TAG_START_RE)) {
    const tagStart = m.index;
    if (spans.length > 0) {
      const [prevStart, prevEnd] = spans[spans.length - 1];
      if (tagStart > prevStart && tagStart <= prevEnd) continue;
    }
    let i = tagStart + m[0].length;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inBacktick = false;
    let braceDepth = 0;
    let terminator = -1;
    while (i < source.length) {
      const ch = source[i];
      if (inSingleQuote) {
        if (ch === "'") inSingleQuote = false;
        else if (ch === '\\' && i + 1 < source.length) i++;
      } else if (inDoubleQuote) {
        if (ch === '"') inDoubleQuote = false;
        else if (ch === '\\' && i + 1 < source.length) i++;
      } else if (inBacktick) {
        if (ch === '`') inBacktick = false;
        else if (ch === '\\' && i + 1 < source.length) i++;
      } else if (ch === "'") {
        inSingleQuote = true;
      } else if (ch === '"') {
        inDoubleQuote = true;
      } else if (ch === '`') {
        inBacktick = true;
      } else if (ch === '{') {
        braceDepth++;
      } else if (ch === '}' && braceDepth > 0) {
        braceDepth--;
      } else if (braceDepth === 0 && ch === '>') {
        terminator = i;
        break;
      }
      i++;
    }
    if (terminator !== -1) {
      if (source.slice(tagStart, terminator).includes('\n\n')) continue;
      spans.push([tagStart, terminator]);
    }
  }
  return spans;
}

function isOffsetInsideAnyRegion(offset: number, regions: Array<[number, number]>): boolean {
  if (regions.length === 0) return false;
  let lo = 0;
  let hi = regions.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const [start, end] = regions[mid];
    if (offset <= start) hi = mid - 1;
    else if (offset > end) lo = mid + 1;
    else return true;
  }
  return false;
}

function isUppercaseJsxSelfClosingAt(
  scanStart: number,
  result: string,
  nextBlankLine: number,
): boolean {
  const scanEnd = Math.min(result.length, nextBlankLine);
  let inDoubleQuote = false;
  let braceDepth = 0;
  for (let i = scanStart; i < scanEnd; i++) {
    const ch = result[i];
    if (inDoubleQuote) {
      if (ch === '"') inDoubleQuote = false;
      if (ch === '\\' && i + 1 < scanEnd) i++;
      continue;
    }
    if (ch === '"') {
      inDoubleQuote = true;
      continue;
    }
    if (ch === '{') {
      braceDepth++;
      continue;
    }
    if (ch === '}' && braceDepth > 0) {
      braceDepth--;
      continue;
    }
    if (braceDepth > 0) continue;
    if (ch === '>') {
      return i > 0 && result[i - 1] === '/';
    }
  }
  return false;
}

export interface BraceSpan {
  readonly start: number;
  readonly end: number;
}

export function scanBraceSpans(
  source: string,
  options: { readonly escapeAware: boolean },
): { readonly matched: readonly BraceSpan[]; readonly unmatched: readonly number[] } {
  const unmatched = unmatchedBraceOpeners(source, options.escapeAware);
  const skip = new Set<number>(unmatched);
  const matched: BraceSpan[] = [];
  const stack: number[] = [];
  forEachBrace(source, options.escapeAware, {
    onFlush: () => {
      stack.length = 0;
    },
    onBrace: (i, char) => {
      if (skip.has(i)) return;
      if (char === '{') {
        stack.push(i);
      } else if (stack.length > 0) {
        const open = stack.pop() as number;
        if (stack.length === 0) matched.push({ start: open, end: i + 1 });
      }
    },
  });
  return { matched, unmatched };
}

function unmatchedBraceOpeners(source: string, escapeAware: boolean): number[] {
  const unmatched: number[] = [];
  const stack: number[] = [];
  forEachBrace(source, escapeAware, {
    onFlush: () => {
      unmatched.push(...stack);
      stack.length = 0;
    },
    onBrace: (i, char) => {
      if (char === '{') stack.push(i);
      else if (stack.length > 0) stack.pop();
    },
  });
  unmatched.push(...stack);
  return unmatched;
}

function forEachBrace(
  source: string,
  escapeAware: boolean,
  visitor: { onFlush: () => void; onBrace: (index: number, char: '{' | '}') => void },
): void {
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') {
      const next = source[i + 1];
      if (next === '\n' || next === '>') {
        visitor.onFlush();
        if (next === '\n') {
          while (source[i + 1] === '\n') i++;
        }
        continue;
      }
    }
    const char = source[i];
    if (char !== '{' && char !== '}') continue;
    if (escapeAware) {
      let bs = 0;
      for (let j = i - 1; j >= 0 && source[j] === '\\'; j--) bs++;
      if (bs % 2 === 1) continue;
    }
    visitor.onBrace(i, char);
  }
}

export function protectFromMdx(source: string): string {
  let result = source;

  if (HAS_LITERAL_SENTINEL_RE.test(result)) {
    for (const [sentinel, escapeChar] of LITERAL_SENTINEL_ESCAPES) {
      result = result.replaceAll(sentinel, escapeChar);
    }
  }

  result = result.replace(HTML_COMMENT_RE, (match) => {
    return match.replace(/</g, GUARD_OPEN).replace(/>/g, GUARD_CLOSE);
  });

  result = result.replace(AUTOLINK_RE, (_match, uri: string) => {
    const safe = uri.replaceAll(':', GUARD_COLON).replaceAll('@', GUARD_AT);
    return `${GUARD_OPEN}${safe}${GUARD_CLOSE}`;
  });

  const exemptedClosers = new Map<string, number>();
  const codeRegions = [...findFencedRegions(result), ...findInlineCodeRegions(result)];
  result = result.replace(HTML_CLOSE_TAG_RE, (match, tag: string, offset: number) => {
    if (LOWERCASE_PAIRED_JSX_TAGS.has(tag)) {
      const used = exemptedClosers.get(tag) ?? 0;
      if (used < countOpenersBefore(result, tag, offset, codeRegions)) {
        exemptedClosers.set(tag, used + 1);
        return match;
      }
    }
    return match.replace(/</g, GUARD_OPEN).replace(/>/g, GUARD_CLOSE);
  });

  result = result.replace(LOWERCASE_HTML_TAG_RE, (match, tag: string) => {
    if (LOWERCASE_JSX_CANONICAL_TAGS.has(tag) && match.endsWith('/>')) {
      return match;
    }
    if (LOWERCASE_PAIRED_JSX_TAGS.has(tag)) {
      return match;
    }
    if (tag[0] === tag[0].toLowerCase() && tag[0] !== tag[0].toUpperCase()) {
      return match.replace(/</g, GUARD_OPEN).replace(/>/g, GUARD_CLOSE);
    }
    return match;
  });

  result = result.replace(/<>/g, `${GUARD_OPEN}${GUARD_CLOSE}`);

  const closeTagOffsets = indexUppercaseCloseTagsByName(result);
  const paragraphBreaks = indexParagraphBreaks(result);
  const greaterThanOffsets = indexGreaterThan(result);
  const uppercaseTagSpans = indexUppercaseTagSpans(result);

  result = result.replace(/</g, (match, offset) => {
    if (isAngleBracketDestinationOpen(offset, result)) return match;

    if (isOffsetInsideAnyRegion(offset, uppercaseTagSpans)) return match;

    const lookahead = result.slice(offset, offset + 256);

    if (lookahead[1] === '/') {
      if (/^<\/[a-zA-Z][a-zA-Z0-9.]*[ \t]*>/.test(lookahead)) return match;
      return GUARD_OPEN;
    }

    const lowercaseNameMatch = /^<([a-z][a-z0-9]*)/.exec(lookahead);
    if (
      lowercaseNameMatch &&
      LOWERCASE_JSX_CANONICAL_TAGS.has(lowercaseNameMatch[1]) &&
      isSelfClosingTagAt(offset, result, greaterThanOffsets, paragraphBreaks)
    ) {
      return match;
    }

    const lowercasePairedMatch = /^<([a-z][a-z0-9]*)([\s/>])/.exec(lookahead);
    if (lowercasePairedMatch && LOWERCASE_PAIRED_JSX_TAGS.has(lowercasePairedMatch[1])) {
      const pairedTagName = lowercasePairedMatch[1];
      if (lookahead.startsWith(`<${pairedTagName}/>`)) {
        return match;
      }
      if (result.indexOf(`</${pairedTagName}>`, offset) !== -1) {
        return match;
      }
      return GUARD_OPEN;
    }

    const tagMatch = /^<([A-Z][a-zA-Z0-9.]*)[\s/>]/.exec(lookahead);
    if (!tagMatch) {
      return GUARD_OPEN;
    }

    const tagName = tagMatch[1];

    const pbIdx = lowerBound(paragraphBreaks, offset);
    const nextBlankLine = pbIdx < paragraphBreaks.length ? paragraphBreaks[pbIdx] : result.length;

    const scanStart = offset + 1 + tagName.length;
    if (isUppercaseJsxSelfClosingAt(scanStart, result, nextBlankLine)) {
      return match;
    }

    const positions = closeTagOffsets.get(tagName);
    if (positions) {
      const idx = lowerBound(positions, offset);
      if (idx < positions.length) {
        return match;
      }
    }

    return GUARD_OPEN;
  });

  {
    const { unmatched } = scanBraceSpans(result, { escapeAware: true });

    if (unmatched.length > 0) {
      const chars = result.split('');
      for (const pos of unmatched) {
        chars[pos] = GUARD_OPEN_BRACE;
      }
      result = chars.join('');
    }
  }

  return result;
}

function hasSentinels(s: string): boolean {
  return HAS_LITERAL_SENTINEL_RE.test(s) || HAS_ESCAPED_LITERAL_SENTINEL_RE.test(s);
}

export function restoreFromMdx() {
  return (tree: Root) => {
    visit(tree, (node: Nodes) => {
      const rec = node as unknown as Record<string, unknown>;
      if (typeof rec.value === 'string' && hasSentinels(rec.value)) {
        rec.value = restoreString(rec.value);
      }
      if (typeof rec.url === 'string' && hasSentinels(rec.url)) {
        rec.url = restoreString(rec.url);
      }
      if (typeof rec.title === 'string' && hasSentinels(rec.title)) {
        rec.title = restoreString(rec.title);
      }
      if (typeof rec.alt === 'string' && hasSentinels(rec.alt)) {
        rec.alt = restoreString(rec.alt);
      }
      if (typeof rec.lang === 'string' && hasSentinels(rec.lang)) {
        rec.lang = restoreString(rec.lang);
      }
      if (typeof rec.meta === 'string' && hasSentinels(rec.meta)) {
        rec.meta = restoreString(rec.meta);
      }
    });
  };
}

function restoreString(s: string): string {
  let out = s
    .replaceAll(GUARD_OPEN, '<')
    .replaceAll(GUARD_CLOSE, '>')
    .replaceAll(GUARD_COLON, ':')
    .replaceAll(GUARD_AT, '@')
    .replaceAll(GUARD_OPEN_BRACE, '{');
  if (HAS_ESCAPED_LITERAL_SENTINEL_RE.test(out)) {
    for (const [sentinel, escapeChar] of LITERAL_SENTINEL_ESCAPES) {
      out = out.replaceAll(escapeChar, sentinel);
    }
  }
  return out;
}
