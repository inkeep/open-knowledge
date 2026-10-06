import type { Nodes, Root } from 'mdast';
import { visit } from 'unist-util-visit';
import {
  angleDestinationEscapesBackslashBefore,
  angleDestinationReproducesEscapeOf,
  isAsciiPunctuation,
} from './angle-destination-escapes.ts';
import { BACKSLASH_ESCAPE_PUA_MARK } from './backslash-escape-guard.ts';
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
  destinations: AngleDestinationIndex,
): number {
  let count = 0;
  let from = 0;
  const needle = `<${tag}`;
  while (from < offset) {
    const at = source.indexOf(needle, from);
    if (at === -1 || at >= offset) break;
    from = at + needle.length;
    if (isReservedOpen(destinations, at)) continue;
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

function indexUppercaseCloseTagsByName(
  source: string,
  destinations: AngleDestinationIndex,
): Map<string, number[]> {
  const index = new Map<string, number[]>();
  const re = new RegExp(UPPERCASE_CLOSE_TAG_INDEX_RE.source, 'g');
  let m = re.exec(source);
  while (m !== null) {
    if (isReservedOpen(destinations, m.index)) {
      m = re.exec(source);
      continue;
    }
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

function indexLiteralDoubleNewlines(source: string): number[] {
  const offsets: number[] = [];
  let i = source.indexOf('\n\n');
  while (i !== -1) {
    offsets.push(i);
    i = source.indexOf('\n\n', i + 1);
  }
  return offsets;
}

const ANGLE_DEST_SCAN_CAP = 1024;

const DEFINITION_LABEL_SIZE_MAX = 999;

const DEFINITION_LINE_START_RE = /(?<![^\n\r]) {0,3}\[/g;

const TABLE_DELIMITER_ROW_RE = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

interface AngleDestinationIndex {
  readonly opens: ReadonlySet<number>;
  readonly closes: ReadonlySet<number>;
  readonly forced: ReadonlySet<number>;
}

function isReservedOpen(index: AngleDestinationIndex, offset: number): boolean {
  return index.opens.has(offset) || index.forced.has(offset);
}

function isGuardSentinel(ch: string | undefined): boolean {
  return (
    ch === GUARD_OPEN ||
    ch === GUARD_CLOSE ||
    ch === GUARD_COLON ||
    ch === GUARD_AT ||
    ch === GUARD_OPEN_BRACE
  );
}

function isSpaceOrTab(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t';
}

function isLineEnding(ch: string | undefined): boolean {
  return ch === '\n' || ch === '\r';
}

function skipSpacesAndTabs(offset: number, source: string): number {
  let j = offset;
  while (isSpaceOrTab(source[j])) j++;
  return j;
}

function lineEndingEnd(offset: number, source: string): number {
  return source[offset] === '\r' && source[offset + 1] === '\n' ? offset + 1 : offset;
}

function inlineLabelStart(labelEnd: number, result: string): number {
  let bs = 0;
  for (let j = labelEnd - 1; j >= 0 && result[j] === '\\'; j--) bs++;
  if (bs % 2 === 1) return -1;

  const scanFloor = Math.max(0, labelEnd - ANGLE_DEST_SCAN_CAP);
  for (let j = labelEnd - 1; j >= scanFloor; j--) {
    const ch = result[j];
    if (isLineEnding(ch) || ch === '`') return -1;
    if (ch !== '[' && ch !== ']') continue;
    if (isBackslashEscaped(j, result)) continue;
    if (ch === ']') return -1;
    if (result[j + 1] === '^') return -1;
    if (result[j - 1] === ']') return -1;
    return j;
  }
  return -1;
}

function isBackslashEscaped(offset: number, source: string): boolean {
  let count = 0;
  for (let j = offset - 1; j >= 0 && source[j] === '\\'; j--) count++;
  return count % 2 === 1;
}

function hasUnescapedPipe(from: number, to: number, source: string): boolean {
  for (let j = from; j < to; j++) {
    if (source[j] === '|' && !isBackslashEscaped(j, source)) return true;
  }
  return false;
}

function isTableDelimiterRowAfter(offset: number, source: string): boolean {
  let lineStart = offset;
  while (lineStart < source.length && !isLineEnding(source[lineStart])) lineStart++;
  if (lineStart >= source.length) return false;
  lineStart = lineEndingEnd(lineStart, source) + 1;
  let lineEnd = lineStart;
  while (lineEnd < source.length && !isLineEnding(source[lineEnd])) lineEnd++;
  const line = source.slice(lineStart, lineEnd);
  return TABLE_DELIMITER_ROW_RE.test(line) && /[|:]/.test(line);
}

function isSerializableAfterEscapedBackslash(ch: string | undefined): boolean {
  return ch === BACKSLASH_ESCAPE_PUA_MARK || angleDestinationEscapesBackslashBefore(ch);
}

function enclosedDestinationClose(offset: number, result: string, escapedOpens: number[]): number {
  const scanCeil = Math.min(result.length, offset + 1 + ANGLE_DEST_SCAN_CAP);
  for (let j = offset + 1; j < scanCeil; j++) {
    const ch = result[j];
    if (ch === '>') return j;
    if (ch === BACKSLASH_ESCAPE_PUA_MARK && result[j + 1] === '<') {
      escapedOpens.push(j + 1);
      j++;
      continue;
    }
    if (ch === '<' || isLineEnding(ch) || isGuardSentinel(ch)) return -1;
    if (ch === '\\') {
      const next = result[j + 1];
      if (next === '\\' && !isSerializableAfterEscapedBackslash(result[j + 2])) return -1;
      if (angleDestinationReproducesEscapeOf(next)) j++;
      else if (isAsciiPunctuation(next)) return -1;
    }
  }
  return -1;
}

function titleEnd(offset: number, result: string): number {
  const opener = result[offset];
  const marker = opener === '(' ? ')' : opener === '"' || opener === "'" ? opener : null;
  if (marker === null) return -1;
  const scanCeil = Math.min(result.length, offset + 1 + ANGLE_DEST_SCAN_CAP);
  for (let j = offset + 1; j < scanCeil; j++) {
    const ch = result[j];
    if (ch === marker) return j + 1;
    if (isLineEnding(ch) || (marker === ')' && ch === '(')) return -1;
    if (ch === '\\') {
      const next = result[j + 1];
      if (next === marker || next === '\\' || (marker === ')' && next === '(')) j++;
    }
  }
  return -1;
}

function resourceEnd(offset: number, result: string): number {
  if (result[offset] === ')') return offset;
  const titleStart = skipSpacesAndTabs(offset, result);
  if (titleStart === offset) return -1;
  const afterTitle = titleEnd(titleStart, result);
  return afterTitle !== -1 && result[afterTitle] === ')' ? afterTitle : -1;
}

function resourceAngleDestinationClose(
  offset: number,
  result: string,
  escapedOpens: number[],
): number {
  const labelStart = inlineLabelStart(offset - 2, result);
  if (labelStart === -1) return -1;
  const destClose = enclosedDestinationClose(offset, result, escapedOpens);
  if (destClose === -1) return -1;
  const end = resourceEnd(destClose + 1, result);
  if (end === -1 || hasUnescapedPipe(labelStart, end, result)) return -1;
  return destClose;
}

function isBlankLineBefore(lineStart: number, source: string): boolean {
  let j = lineStart - 2;
  if (source[j] === '\r') j--;
  for (; j >= 0 && source[j] !== '\n'; j--) {
    if (!isSpaceOrTab(source[j])) return false;
  }
  return true;
}

function definitionLabelEnd(bracket: number, source: string): number {
  if (source[bracket + 1] === '^') return -1;
  let seenContent = false;
  const scanCeil = Math.min(source.length, bracket + 2 + DEFINITION_LABEL_SIZE_MAX);
  for (let j = bracket + 1; j < scanCeil; j++) {
    const ch = source[j];
    if (ch === ']') return seenContent ? j : -1;
    if (ch === '[' || isLineEnding(ch)) return -1;
    if (ch === '\\') {
      const next = source[j + 1];
      if (next === '[' || next === ']' || next === '\\') j++;
      seenContent = true;
      continue;
    }
    if (!isSpaceOrTab(ch)) seenContent = true;
  }
  return -1;
}

function definitionTitleLineEnd(lineEnd: number, source: string): number {
  const titleStart = skipSpacesAndTabs(lineEnd + 1, source);
  const afterTitle = titleEnd(titleStart, source);
  if (afterTitle === -1) return lineEnd;
  const j = skipSpacesAndTabs(afterTitle, source);
  if (j >= source.length) return source.length;
  return isLineEnding(source[j]) ? lineEndingEnd(j, source) : lineEnd;
}

function definitionEnd(offset: number, source: string): number {
  let j = skipSpacesAndTabs(offset, source);
  if (j >= source.length) return source.length;
  if (isLineEnding(source[j])) return definitionTitleLineEnd(lineEndingEnd(j, source), source);
  if (j === offset) return -1;
  const afterTitle = titleEnd(j, source);
  if (afterTitle === -1) return -1;
  j = skipSpacesAndTabs(afterTitle, source);
  if (j >= source.length) return source.length;
  return isLineEnding(source[j]) ? lineEndingEnd(j, source) : -1;
}

function indexDefinitionAngleDestinations(
  source: string,
  opens: Set<number>,
  closes: Set<number>,
  forced: Set<number>,
): void {
  let lastDefinitionEnd = -1;
  for (const m of source.matchAll(DEFINITION_LINE_START_RE)) {
    const lineStart = m.index;
    if (
      lineStart !== 0 &&
      lineStart !== lastDefinitionEnd + 1 &&
      !isBlankLineBefore(lineStart, source)
    ) {
      continue;
    }
    const labelEnd = definitionLabelEnd(lineStart + m[0].length - 1, source);
    if (labelEnd === -1 || source[labelEnd + 1] !== ':') continue;
    const lt = skipSpacesAndTabs(labelEnd + 2, source);
    if (source[lt] !== '<') continue;
    const escapedOpens: number[] = [];
    const gt = enclosedDestinationClose(lt, source, escapedOpens);
    if (gt === -1) continue;
    const end = definitionEnd(gt + 1, source);
    if (end === -1 || isTableDelimiterRowAfter(gt, source)) continue;
    opens.add(lt);
    closes.add(gt);
    for (const at of escapedOpens) forced.add(at);
    lastDefinitionEnd = end;
  }
}

function indexAngleDestinations(source: string): AngleDestinationIndex {
  const opens = new Set<number>();
  const closes = new Set<number>();
  const forced = new Set<number>();
  let at = source.indexOf('](<');
  while (at !== -1) {
    const escapedOpens: number[] = [];
    const close = resourceAngleDestinationClose(at + 2, source, escapedOpens);
    if (close !== -1) {
      opens.add(at + 2);
      closes.add(close);
      for (const forcedAt of escapedOpens) forced.add(forcedAt);
    }
    at = source.indexOf('](<', at + 3);
  }
  indexDefinitionAngleDestinations(source, opens, closes, forced);
  return { opens, closes, forced };
}

function hasLiveCloserAfter(
  source: string,
  tag: string,
  offset: number,
  destinations: AngleDestinationIndex,
): boolean {
  const needle = `</${tag}>`;
  let at = source.indexOf(needle, offset);
  while (at !== -1) {
    if (!isReservedOpen(destinations, at)) return true;
    at = source.indexOf(needle, at + 1);
  }
  return false;
}

function guardAngleBrackets(
  match: string,
  offset: number,
  destinations: AngleDestinationIndex,
): string {
  let out = '';
  for (let i = 0; i < match.length; i++) {
    const ch = match[i];
    if (ch === '<') out += destinations.opens.has(offset + i) ? ch : GUARD_OPEN;
    else if (ch === '>') out += destinations.closes.has(offset + i) ? ch : GUARD_CLOSE;
    else out += ch;
  }
  return out;
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
  const doubleNewlineOffsets = indexLiteralDoubleNewlines(source);
  const TAG_START_RE = /<\/?([A-Z][A-Za-z0-9.]*)/g;
  for (const m of source.matchAll(TAG_START_RE)) {
    const tagStart = m.index;
    if (spans.length > 0) {
      const [prevStart, prevEnd] = spans[spans.length - 1];
      if (tagStart > prevStart && tagStart <= prevEnd) continue;
    }
    let i = tagStart + m[0].length;
    const dnIdx = lowerBound(doubleNewlineOffsets, tagStart);
    const scanEnd =
      dnIdx < doubleNewlineOffsets.length ? doubleNewlineOffsets[dnIdx] : source.length;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inBacktick = false;
    let braceDepth = 0;
    let terminator = -1;
    while (i < scanEnd) {
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
    if (terminator !== -1) spans.push([tagStart, terminator]);
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
  destinations: AngleDestinationIndex,
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
    if (ch === '>' && !destinations.closes.has(i)) {
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

  const angleDestinations = indexAngleDestinations(result);

  result = result.replace(AUTOLINK_RE, (match, uri: string, offset: number) => {
    if (angleDestinations.opens.has(offset)) return match;
    if (angleDestinations.forced.has(offset)) return `${GUARD_OPEN}${match.slice(1)}`;
    const safe = uri.replaceAll(':', GUARD_COLON).replaceAll('@', GUARD_AT);
    return `${GUARD_OPEN}${safe}${GUARD_CLOSE}`;
  });

  const exemptedClosers = new Map<string, number>();
  const codeRegions = [...findFencedRegions(result), ...findInlineCodeRegions(result)];
  result = result.replace(HTML_CLOSE_TAG_RE, (match, tag: string, offset: number) => {
    if (angleDestinations.opens.has(offset)) return match;
    if (angleDestinations.forced.has(offset)) return `${GUARD_OPEN}${match.slice(1)}`;
    if (LOWERCASE_PAIRED_JSX_TAGS.has(tag)) {
      const used = exemptedClosers.get(tag) ?? 0;
      if (used < countOpenersBefore(result, tag, offset, codeRegions, angleDestinations)) {
        exemptedClosers.set(tag, used + 1);
        return match;
      }
    }
    return match.replace(/</g, GUARD_OPEN).replace(/>/g, GUARD_CLOSE);
  });

  result = result.replace(
    LOWERCASE_HTML_TAG_RE,
    (match, tag: string, _attributes: string | undefined, offset: number) => {
      if (angleDestinations.opens.has(offset)) return match;
      if (angleDestinations.forced.has(offset)) {
        return guardAngleBrackets(match, offset, angleDestinations);
      }
      if (LOWERCASE_JSX_CANONICAL_TAGS.has(tag) && match.endsWith('/>')) {
        return match;
      }
      if (LOWERCASE_PAIRED_JSX_TAGS.has(tag)) {
        return match;
      }
      if (tag[0] === tag[0].toLowerCase() && tag[0] !== tag[0].toUpperCase()) {
        return guardAngleBrackets(match, offset, angleDestinations);
      }
      return match;
    },
  );

  result = result.replace(/<>/g, (match, offset: number) =>
    angleDestinations.opens.has(offset)
      ? match
      : guardAngleBrackets(match, offset, angleDestinations),
  );

  const closeTagOffsets = indexUppercaseCloseTagsByName(result, angleDestinations);
  const paragraphBreaks = indexParagraphBreaks(result);
  const greaterThanOffsets = indexGreaterThan(result);
  const uppercaseTagSpans = indexUppercaseTagSpans(result);

  result = result.replace(/</g, (match, offset) => {
    if (angleDestinations.opens.has(offset)) return match;
    if (angleDestinations.forced.has(offset)) return GUARD_OPEN;

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
      if (hasLiveCloserAfter(result, pairedTagName, offset, angleDestinations)) {
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
    if (isUppercaseJsxSelfClosingAt(scanStart, result, nextBlankLine, angleDestinations)) {
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
        if (rec.url.startsWith(GUARD_OPEN)) recordGuardedDestinationOpen(node);
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

function recordGuardedDestinationOpen(node: Nodes): void {
  if (node.type !== 'link' && node.type !== 'image' && node.type !== 'definition') return;
  node.data ??= {};
  node.data.sourceGuardedDestinationOpen = true;
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
