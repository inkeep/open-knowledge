import type { Text } from 'mdast';
import type { Point, Position } from 'unist';
import {
  type EntityReferenceSpan,
  type EscapeProvenanceEntry,
  hasEscapeProvenance,
} from './mdast-augmentation.ts';

function consumesEscape(source: string, i: number, valueChar: string): boolean {
  return source[i] === '\\' && i + 1 < source.length && source[i + 1] === valueChar;
}

function valueOffsetToSourceOffset(
  source: string,
  parentSourceStart: number,
  valueText: string,
  targetValueOffset: number,
): number {
  let srcCursor = parentSourceStart;
  let valCursor = 0;
  while (valCursor < targetValueOffset && srcCursor < source.length) {
    const continuationEnd =
      valCursor > 0 && valueText[valCursor - 1] === '\n'
        ? containerContinuationEnd(source, srcCursor, valueText[valCursor])
        : null;
    if (continuationEnd !== null) srcCursor = continuationEnd;
    srcCursor += consumesEscape(source, srcCursor, valueText[valCursor]) ? 2 : 1;
    valCursor += 1;
  }
  return srcCursor;
}

function sourceMatchesValueAt(source: string, offset: number, valueChar: string): boolean {
  return source[offset] === valueChar || consumesEscape(source, offset, valueChar);
}

function containerContinuationEnd(
  source: string,
  sourceOffset: number,
  valueChar: string,
): number | null {
  let cursor = sourceOffset;
  let consumed = false;
  for (;;) {
    const indentStart = cursor;
    while (cursor < source.length && (source[cursor] === ' ' || source[cursor] === '\t')) {
      cursor += 1;
    }
    if (source[cursor] === '>') {
      cursor += 1;
      if (source[cursor] === ' ' || source[cursor] === '\t') cursor += 1;
      consumed = true;
      continue;
    }
    if (cursor > indentStart) consumed = true;
    break;
  }
  return consumed && sourceMatchesValueAt(source, cursor, valueChar) ? cursor : null;
}

export function escapedValueOffsets(node: Text): ReadonlySet<number> | null {
  if (!hasEscapeProvenance(node.data)) return null;
  return new Set(node.data.escapedChars.map((entry) => entry.offset));
}

function sliceEscapedChars(
  entries: readonly EscapeProvenanceEntry[],
  from: number,
  to: number,
): EscapeProvenanceEntry[] {
  return entries
    .filter((entry) => entry.offset >= from && entry.offset < to)
    .map((entry) => ({ ...entry, offset: entry.offset - from }));
}

function sliceEntityRefSpans(
  spans: readonly EntityReferenceSpan[],
  from: number,
  to: number,
): EntityReferenceSpan[] {
  return spans
    .filter((span) => span.offset >= from && span.offset + span.length <= to)
    .map((span) => ({ ...span, offset: span.offset - from }));
}

export function sliceTextWithProvenance(
  source: string,
  node: Text,
  from: number,
  to: number,
): Text {
  const sliced: Text = { type: 'text', value: node.value.slice(from, to) };
  const position = deriveFragmentPosition(source, node, from, to);
  if (position) sliced.position = position;

  let data: Text['data'];
  if (hasEscapeProvenance(node.data)) {
    data = { escapedChars: sliceEscapedChars(node.data.escapedChars, from, to) };
  }
  if (node.data?.entityRefSpans?.length) {
    const entityRefSpans = sliceEntityRefSpans(node.data.entityRefSpans, from, to);
    if (entityRefSpans.length > 0) data = { ...data, entityRefSpans };
  }
  if (data) sliced.data = data;
  return sliced;
}

export function isEscapeDerivedRun(
  escaped: ReadonlySet<number> | null,
  valueOffset: number,
  length: number,
): boolean {
  if (escaped === null || escaped.size === 0) return false;
  for (let k = 0; k < length; k++) {
    if (escaped.has(valueOffset + k)) return true;
  }
  return false;
}

function offsetToPoint(source: string, offset: number): Point {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column, offset };
}

function makePosition(source: string, startOffset: number, endOffset: number): Position {
  return {
    start: offsetToPoint(source, startOffset),
    end: offsetToPoint(source, endOffset),
  };
}

export function deriveFragmentPosition(
  source: string,
  parentNode: Text,
  valueStart: number,
  valueEnd: number,
): Position | undefined {
  if (!source || !parentNode.position || typeof parentNode.position.start?.offset !== 'number') {
    return undefined;
  }
  const parentOff = parentNode.position.start.offset;
  const srcStart = valueOffsetToSourceOffset(source, parentOff, parentNode.value, valueStart);
  const srcEnd = valueOffsetToSourceOffset(source, parentOff, parentNode.value, valueEnd);
  return makePosition(source, srcStart, srcEnd);
}
