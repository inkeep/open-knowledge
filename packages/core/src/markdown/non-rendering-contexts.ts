import { createCodeFenceTracker } from '../utils/code-fence-tracker.ts';

export interface MaskableLine {
  text: string;
  start: number;
}

function maskRange(chars: string[], start: number, end: number): void {
  for (let i = start; i < end; i++) chars[i] = ' ';
}

function rawTagAt(line: string, start: number): 'pre' | 'code' | null {
  if (line[start] !== '<') return null;
  const lower = line.slice(start).toLowerCase();
  for (const tag of ['pre', 'code'] as const) {
    if (!lower.startsWith(`<${tag}`)) continue;
    const boundary = line[start + tag.length + 1];
    if (boundary === '>' || boundary === '/' || boundary === ' ' || boundary === '\t') return tag;
  }
  return null;
}

function htmlTagEnd(line: string, start: number): number | null {
  let quote: '"' | "'" | null = null;
  for (let i = start; i < line.length; i++) {
    const char = line[i];
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return i + 1;
    }
  }
  return null;
}

function rawClosingTagEnd(line: string, start: number, tag: 'pre' | 'code'): number | null {
  const match = new RegExp(`</${tag}\\s*>`, 'i').exec(line.slice(start));
  return match?.index === undefined ? null : start + match.index + match[0].length;
}

export function skipInlineCode(line: string, start: number): number | null {
  let runLength = 0;
  while (line[start + runLength] === '`') runLength += 1;
  if (runLength === 0) return null;
  const openEnd = start + runLength;
  let i = openEnd;
  while (i < line.length) {
    if (line[i] !== '`') {
      i += 1;
      continue;
    }
    let closeLen = 0;
    while (line[i + closeLen] === '`') closeLen += 1;
    if (closeLen === runLength) return i + runLength;
    i += closeLen;
  }
  return openEnd;
}

export function maskNonRenderingContextLines(lines: MaskableLine[]): MaskableLine[] {
  const inFence = createCodeFenceTracker();
  let inComment = false;
  let rawTag: 'pre' | 'code' | null = null;

  return lines.map(({ text, start }) => {
    if (rawTag === null && !inComment) {
      const fenced = inFence(text);
      if (fenced) {
        return { text: ' '.repeat(text.length), start };
      }
    }

    const chars = text.split('');
    let cursor = 0;
    while (cursor < text.length) {
      if (inComment) {
        const close = text.indexOf('-->', cursor);
        const end = close < 0 ? text.length : close + 3;
        maskRange(chars, cursor, end);
        cursor = end;
        if (close < 0) break;
        inComment = false;
        continue;
      }
      if (rawTag !== null) {
        const end = rawClosingTagEnd(text, cursor, rawTag);
        maskRange(chars, cursor, end ?? text.length);
        if (end === null) break;
        cursor = end;
        rawTag = null;
        continue;
      }

      const commentStart = text.indexOf('<!--', cursor);
      let rawStart = -1;
      let nextRawTag: 'pre' | 'code' | null = null;
      for (let i = cursor; i < text.length; i++) {
        const found = rawTagAt(text, i);
        if (found !== null) {
          rawStart = i;
          nextRawTag = found;
          break;
        }
      }
      const inlineCodeStart = text.indexOf('`', cursor);
      const firstHtmlStart =
        commentStart < 0
          ? rawStart
          : rawStart < 0
            ? commentStart
            : Math.min(commentStart, rawStart);
      if (inlineCodeStart >= 0 && (firstHtmlStart < 0 || inlineCodeStart < firstHtmlStart)) {
        cursor = skipInlineCode(text, inlineCodeStart) ?? inlineCodeStart + 1;
        continue;
      }
      if (commentStart < 0 && rawStart < 0) break;
      if (commentStart >= 0 && (rawStart < 0 || commentStart < rawStart)) {
        const close = text.indexOf('-->', commentStart + 4);
        const end = close < 0 ? text.length : close + 3;
        maskRange(chars, commentStart, end);
        cursor = end;
        inComment = close < 0;
        if (inComment) break;
        continue;
      }

      const openEnd = htmlTagEnd(text, rawStart);
      if (openEnd === null || nextRawTag === null) break;
      const closeEnd = rawClosingTagEnd(text, openEnd, nextRawTag);
      const end = closeEnd ?? text.length;
      maskRange(chars, rawStart, end);
      cursor = end;
      rawTag = closeEnd === null ? nextRawTag : null;
      if (rawTag !== null) break;
    }
    return { text: chars.join(''), start };
  });
}

export function maskNonRenderingContexts(source: string): string {
  const lines: MaskableLine[] = [];
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\n') {
      lines.push({ text: source.slice(start, i), start });
      start = i + 1;
    } else if (ch === '\r') {
      lines.push({ text: source.slice(start, i), start });
      if (source[i + 1] === '\n') i += 1;
      start = i + 1;
    }
  }
  lines.push({ text: source.slice(start), start });

  const masked = maskNonRenderingContextLines(lines);
  const out = source.split('');
  for (const line of masked) {
    for (let i = 0; i < line.text.length; i++) {
      out[line.start + i] = line.text[i] as string;
    }
  }
  return out.join('');
}

export function isNonRenderingRange(
  source: string,
  maskedSource: string,
  start: number,
  end: number,
): boolean {
  if (end <= start) return false;
  const original = source.slice(start, end);
  if (original.trim().length === 0) return false;
  return maskedSource.slice(start, end).trim().length === 0;
}
