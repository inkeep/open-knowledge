import type { Node as PmNode } from '@tiptap/pm/model';
import type { Position } from 'unist';

export interface PmSourceSpan {
  from: number;
  to: number;
  sourceStart: number;
  sourceEnd: number;
  type: string;
  depth: number;
  mapped: boolean;
}

export type PmSourceMapPrecision = 'full' | 'block';

export interface PmSourceMap {
  readonly precision: PmSourceMapPrecision;
  readonly spans: readonly PmSourceSpan[];
  readonly blocks: readonly PmSourceSpan[];
  readonly sourceLength: number;
  readonly docSize: number;
  pmPosToSourceOffset(pos: number): number;
  sourceOffsetToPmPos(offset: number): number;
  blockIndexForPmPos(pos: number): number | null;
  blockIndexForSourceOffset(offset: number): number | null;
  blockRangeToSourceRange(fromBlock: number, toBlock: number): { from: number; to: number } | null;
}

interface Positioned {
  position?: Position | undefined;
  children?: unknown;
}

export interface SourceMapRecorder {
  readonly positions: WeakMap<PmNode, Position>;
  record(mdastNode: unknown, result: unknown): void;
}

export interface SourceMapRecorderHolder {
  current: SourceMapRecorder | null;
}

function positionOf(node: unknown): Position | null {
  if (typeof node !== 'object' || node === null) return null;
  const position = (node as Positioned).position;
  if (position === undefined || typeof position.start?.offset !== 'number') return null;
  if (typeof position.end?.offset !== 'number') return null;
  return position;
}

function isPmNode(value: unknown): value is PmNode {
  return typeof value === 'object' && value !== null && 'type' in value && 'nodeSize' in value;
}

function childNodesOf(node: unknown, count: number): unknown[] | null {
  if (typeof node !== 'object' || node === null) return null;
  const children = (node as Positioned).children;
  if (!Array.isArray(children) || children.length !== count) return null;
  return children;
}

export function createSourceMapRecorder(): SourceMapRecorder {
  const positions = new WeakMap<PmNode, Position>();

  const set = (value: unknown, position: Position | null): boolean => {
    if (position === null || !isPmNode(value)) return false;
    if (positions.has(value)) return false;
    positions.set(value, position);
    return true;
  };

  const descend = (pmNode: PmNode, mdastNode: unknown): void => {
    const kids = childNodesOf(mdastNode, pmNode.childCount);
    if (kids === null) return;
    for (let i = 0; i < kids.length; i++) {
      const child = pmNode.child(i);
      if (set(child, positionOf(kids[i]))) descend(child, kids[i]);
    }
  };

  return {
    positions,
    record(mdastNode, result) {
      const own = positionOf(mdastNode);
      if (Array.isArray(result)) {
        const kids = childNodesOf(mdastNode, result.length);
        for (let i = 0; i < result.length; i++) {
          const kid = kids?.[i];
          if (
            set(result[i], (kid === undefined ? null : positionOf(kid)) ?? own) &&
            kid !== undefined
          ) {
            descend(result[i] as PmNode, kid);
          }
        }
        return;
      }
      if (set(result, own)) descend(result as PmNode, mdastNode);
    },
  };
}

type HandlerFn = (...args: unknown[]) => unknown;

export function withSourceMapRecording<T extends Record<string, unknown> | undefined>(
  handlers: T,
  holder: SourceMapRecorderHolder,
): T {
  if (handlers === undefined) return handlers;
  const wrapped: Record<string, unknown> = {};
  for (const [name, handler] of Object.entries(handlers)) {
    if (typeof handler !== 'function') {
      wrapped[name] = handler;
      continue;
    }
    const fn = handler as HandlerFn;
    wrapped[name] = (...args: unknown[]) => {
      const result = fn(...args);
      holder.current?.record(args[0], result);
      return result;
    };
  }
  return wrapped as T;
}

export type SourceOffsetAdjuster = (parseOffset: number) => number;

interface WalkContext {
  spans: PmSourceSpan[];
  positions: WeakMap<PmNode, Position>;
  adjust: SourceOffsetAdjuster;
  sourceLength: number;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(value, hi));
}

function walkChildren(
  ctx: WalkContext,
  parent: PmNode,
  parentStart: number,
  parentSource: { start: number; end: number },
  depth: number,
): void {
  const count = parent.childCount;
  if (count === 0) return;

  const children: PmNode[] = [];
  const offsets: number[] = [];
  let cursor = parentStart;
  for (let i = 0; i < count; i++) {
    const child = parent.child(i);
    children.push(child);
    offsets.push(cursor);
    cursor += child.nodeSize;
  }

  const recorded: Array<{ start: number; end: number } | null> = children.map((child) => {
    const position = ctx.positions.get(child);
    if (position === undefined) return null;
    const start = ctx.adjust(position.start.offset as number);
    const end = ctx.adjust(position.end.offset as number);
    return {
      start: clamp(Math.min(start, end), 0, ctx.sourceLength),
      end: clamp(Math.max(start, end), 0, ctx.sourceLength),
    };
  });

  for (let i = 0; i < count; i++) {
    const child = children[i] as PmNode;
    const from = offsets[i] as number;
    const to = from + child.nodeSize;
    const own = recorded[i];
    let span: { start: number; end: number };
    if (own !== null) {
      span = own;
    } else {
      let low = parentSource.start;
      for (let j = i - 1; j >= 0; j--) {
        const prev = recorded[j];
        if (prev !== null) {
          low = prev.end;
          break;
        }
      }
      let high = parentSource.end;
      for (let j = i + 1; j < count; j++) {
        const next = recorded[j];
        if (next !== null) {
          high = next.start;
          break;
        }
      }
      span = { start: low, end: Math.max(low, high) };
    }
    ctx.spans.push({
      from,
      to,
      sourceStart: span.start,
      sourceEnd: span.end,
      type: child.type.name,
      depth,
      mapped: own !== null,
    });
    walkChildren(ctx, child, from + 1, span, depth + 1);
  }
}

function lastIndexAtOrBefore(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] as number) <= value) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

function deepestContaining(
  order: readonly PmSourceSpan[],
  starts: readonly number[],
  endOf: (span: PmSourceSpan) => number,
  value: number,
): PmSourceSpan | null {
  for (let i = lastIndexAtOrBefore(starts, value); i >= 0; i--) {
    const span = order[i] as PmSourceSpan;
    if (endOf(span) > value) return span;
  }
  return null;
}

function interpolate(fromLen: number, toLen: number, rel: number, base: number): number {
  if (fromLen <= 0) return base;
  if (fromLen === toLen) return base + rel;
  return base + Math.round((rel / fromLen) * toLen);
}

function toLineBounds(source: string, from: number, to: number): { from: number; to: number } {
  const floor = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  let start = clamp(from, floor, source.length);
  while (start > floor && source[start - 1] !== '\n') start--;
  let end = clamp(to, start, source.length);
  while (end < source.length && source[end] !== '\n') end++;
  return { from: start, to: end };
}

export function buildPmSourceMap(
  doc: PmNode,
  recorder: SourceMapRecorder,
  source: string,
  adjust: SourceOffsetAdjuster = (offset) => offset,
): PmSourceMap {
  const spans: PmSourceSpan[] = [];
  walkChildren(
    { spans, positions: recorder.positions, adjust, sourceLength: source.length },
    doc,
    0,
    { start: 0, end: source.length },
    1,
  );

  return sourceMapOverSpans(spans, source, doc.content.size, 'full');
}

export function buildBlockSourceMap(
  blocks: readonly PmSourceSpan[],
  sourceLength: number,
  docSize: number,
): PmSourceMap {
  return sourceMapOverSpans([...blocks], { length: sourceLength }, docSize, 'block');
}

export function buildFullSourceMap(
  spans: readonly PmSourceSpan[],
  source: string,
  docSize: number,
): PmSourceMap {
  return sourceMapOverSpans([...spans], source, docSize, 'full');
}

function sourceMapOverSpans(
  spans: PmSourceSpan[],
  source: string | { length: number },
  docSize: number,
  precision: PmSourceMapPrecision,
): PmSourceMap {
  const sourceLength = source.length;
  const text = typeof source === 'string' ? source : null;
  const blocks = spans.filter((span) => span.depth === 1);

  const bySource = [...spans].sort(
    (a, b) => a.sourceStart - b.sourceStart || b.sourceEnd - a.sourceEnd || a.depth - b.depth,
  );
  const pmStarts = spans.map((span) => span.from);
  const sourceStarts = bySource.map((span) => span.sourceStart);

  return {
    precision,
    spans,
    blocks,
    sourceLength,
    docSize,

    pmPosToSourceOffset(pos) {
      const p = clamp(pos, 0, docSize);
      const span = deepestContaining(spans, pmStarts, (s) => s.to, p);
      if (span === null) return p <= 0 ? 0 : sourceLength;
      return clamp(
        interpolate(
          span.to - span.from,
          span.sourceEnd - span.sourceStart,
          p - span.from,
          span.sourceStart,
        ),
        span.sourceStart,
        span.sourceEnd,
      );
    },

    sourceOffsetToPmPos(offset) {
      const o = clamp(offset, 0, sourceLength);
      const span = deepestContaining(bySource, sourceStarts, (s) => s.sourceEnd, o);
      if (span === null) return o <= 0 ? 0 : docSize;
      return clamp(
        interpolate(
          span.sourceEnd - span.sourceStart,
          span.to - span.from,
          o - span.sourceStart,
          span.from,
        ),
        span.from,
        span.to,
      );
    },

    blockIndexForPmPos(pos) {
      if (blocks.length === 0) return null;
      const p = clamp(pos, 0, docSize);
      for (let i = 0; i < blocks.length; i++) {
        if (p < (blocks[i] as PmSourceSpan).to) return i;
      }
      return blocks.length - 1;
    },

    blockIndexForSourceOffset(offset) {
      if (blocks.length === 0) return null;
      const o = clamp(offset, 0, sourceLength);
      for (let i = 0; i < blocks.length; i++) {
        if (o < (blocks[i] as PmSourceSpan).sourceEnd) return i;
      }
      return blocks.length - 1;
    },

    blockRangeToSourceRange(fromBlock, toBlock) {
      const first = clamp(fromBlock, 0, blocks.length);
      const last = clamp(toBlock, first, blocks.length);
      if (last <= first) return null;
      const head = blocks[first] as PmSourceSpan;
      const tail = blocks[last - 1] as PmSourceSpan;
      if (head.sourceStart === tail.sourceEnd) {
        return { from: head.sourceStart, to: head.sourceStart };
      }
      return text === null
        ? { from: head.sourceStart, to: tail.sourceEnd }
        : toLineBounds(text, head.sourceStart, tail.sourceEnd);
    },
  };
}
