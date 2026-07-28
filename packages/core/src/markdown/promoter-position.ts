import type { Text } from 'mdast';
import type { Point, Position } from 'unist';

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
    srcCursor += consumesEscape(source, srcCursor, valueText[valCursor]) ? 2 : 1;
    valCursor += 1;
  }
  return srcCursor;
}

const NO_ESCAPES: ReadonlySet<number> = new Set();

export function escapedValueOffsets(source: string, node: Text): ReadonlySet<number> | null {
  if (!source || !node.position || typeof node.position.start?.offset !== 'number') {
    return null;
  }
  const start = node.position.start.offset;
  const value = node.value;
  const spanEnd = Math.min(
    node.position.end?.offset ?? source.length,
    start + 2 * value.length,
    source.length,
  );
  let hasBackslash = false;
  for (let i = start; i < spanEnd; i++) {
    if (source.charCodeAt(i) === 92 /* \ */) {
      hasBackslash = true;
      break;
    }
  }
  if (!hasBackslash) {
    return NO_ESCAPES;
  }

  let escaped: Set<number> | null = null;
  let srcCursor = start;
  let valCursor = 0;
  while (valCursor < value.length && srcCursor < source.length) {
    if (consumesEscape(source, srcCursor, value[valCursor])) {
      if (escaped === null) escaped = new Set();
      escaped.add(valCursor);
      srcCursor += 2;
    } else if (source[srcCursor] === value[valCursor]) {
      srcCursor += 1;
    } else {
      break;
    }
    valCursor += 1;
  }
  return escaped ?? NO_ESCAPES;
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
