/**
 * Byte-accurate ProseMirror ↔ markdown-source position map.
 *
 * The WYSIWYG document is a *projection* of the `Y.Text('source')` markdown:
 * to splice a locally re-serialized block back into the markdown, and to carry
 * a cursor across a mode switch, the projection has to know which source bytes
 * every ProseMirror node came from. remark retains a `position` on effectively
 * every mdast node it produces; the mdast→PM handler layer drops all of them,
 * because a PM node has no place to put one.
 *
 * This module supplies that place — beside the doc rather than inside it. A
 * recorder is threaded through the handlers, keyed on the PM node objects they
 * return, and a post-parse walk of the finished doc turns those recordings into
 * a flat span table. Keeping it out of the node attrs matters: attrs are part
 * of the schema and would be serialized into the CRDT, into `toJSON`, and into
 * every byte-stability snapshot; a side table is free of all of that and is
 * simply not built when nobody asks for one.
 *
 * ## What "byte-accurate" means here, and where it stops
 *
 * A span whose PM length equals its source length maps char-for-char and is
 * exact. Everywhere else — a paragraph (whose PM length counts its open/close
 * tokens) or a text run that source-escaped some characters — a position
 * interior to the span is interpolated. Callers that need exactness should ask
 * at the granularity the map is exact at: `blocks` (top-level block boundaries,
 * straight from mdast top-level positions) is the granularity the block splice
 * needs, and it never interpolates.
 */

import type { Node as PmNode } from '@tiptap/pm/model';
import type { Position } from 'unist';

/** The source span one ProseMirror node was parsed from. */
export interface PmSourceSpan {
  /** ProseMirror position immediately before the node. */
  from: number;
  /** ProseMirror position immediately after the node. */
  to: number;
  /** Char offset of the node's first source character, in the original markdown. */
  sourceStart: number;
  /** Char offset one past the node's last source character. */
  sourceEnd: number;
  /** PM node type name — for tripwires and debugging, never for indexing. */
  type: string;
  /** Nesting depth below the doc; a top-level block is 1. */
  depth: number;
  /**
   * False when the span was inherited rather than parsed — a node synthesized
   * outside remark (a materialized blank-line paragraph that lost its mint, the
   * non-empty-doc filler) whose span was narrowed from its neighbours. Such a
   * span still bounds the node correctly; it just is not a parse fact.
   */
  mapped: boolean;
}

/**
 * How far down the tree the map's spans go.
 *
 * `full` is a parse result — a span for (nearly) every node. `block` carries
 * only top-level blocks, which is what the write path indexes and all it needs;
 * it is what a splice rebase produces, since rebasing exactly is cheap at the
 * top level and would cost a document parse below it. A consumer that places a
 * character-accurate cursor (a mode switch) should check this and ask for a
 * rebuild rather than interpolate across a whole block.
 */
export type PmSourceMapPrecision = 'full' | 'block';

/** Both directions of the map, plus the block table the splice path indexes. */
export interface PmSourceMap {
  /** See `PmSourceMapPrecision`. */
  readonly precision: PmSourceMapPrecision;
  /** Every node's span, pre-order (a parent precedes its children). */
  readonly spans: readonly PmSourceSpan[];
  /** Top-level block spans, index-aligned with the PM doc's children. */
  readonly blocks: readonly PmSourceSpan[];
  /** Length of the markdown this map was built from. */
  readonly sourceLength: number;
  /** `doc.content.size` of the projected document. */
  readonly docSize: number;
  /** Source offset for a ProseMirror position. */
  pmPosToSourceOffset(pos: number): number;
  /** ProseMirror position for a source offset. */
  sourceOffsetToPmPos(offset: number): number;
  /** Index of the top-level block containing a PM position, or null when there are none. */
  blockIndexForPmPos(pos: number): number | null;
  /** Index of the top-level block containing a source offset, or null when there are none. */
  blockIndexForSourceOffset(offset: number): number | null;
  /**
   * Source char range covering top-level blocks `[fromBlock, toBlock)`,
   * extended to whole lines so a re-serialized block can be spliced in without
   * disturbing the newline structure around it. Null when the range is empty.
   */
  blockRangeToSourceRange(fromBlock: number, toBlock: number): { from: number; to: number } | null;
}

/** Anything carrying a unist `position`; the recorder never reads anything else. */
interface Positioned {
  position?: Position | undefined;
  children?: unknown;
}

/**
 * Collects mdast positions against the PM nodes the handlers return.
 *
 * One recorder serves one parse. `positions` is keyed on node identity, which
 * survives the tree build: `Fragment.from` keeps the node objects it is given,
 * so a block node recorded by its handler is the same object that ends up in
 * the finished doc. (Adjacent text nodes with identical marks are merged into
 * fresh objects and lose their recording; the walk fills those from their
 * parent, which is the paragraph the merge happened in.)
 */
export interface SourceMapRecorder {
  readonly positions: WeakMap<PmNode, Position>;
  record(mdastNode: unknown, result: unknown): void;
}

/** Lets the frozen parse processor hold a recorder slot it can find at call time. */
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

/** mdast children as raw nodes, when the shape allows an index alignment. */
function childNodesOf(node: unknown, count: number): unknown[] | null {
  if (typeof node !== 'object' || node === null) return null;
  const children = (node as Positioned).children;
  if (!Array.isArray(children) || children.length !== count) return null;
  return children;
}

export function createSourceMapRecorder(): SourceMapRecorder {
  const positions = new WeakMap<PmNode, Position>();

  // First write wins. Handlers run innermost-first (a handler calls `state.all`
  // before it builds its own node), so the first recording against any object
  // is the most specific one available — a parent that passes a child straight
  // through (the paragraph unwrap) must not overwrite the child's own span with
  // its coarser one.
  const set = (value: unknown, position: Position | null): boolean => {
    if (position === null || !isPmNode(value)) return false;
    if (positions.has(value)) return false;
    positions.set(value, position);
    return true;
  };

  /**
   * Push positions down a subtree the handler built itself.
   *
   * Most handlers delegate to `state.all`, so their children were recorded by
   * their own handler calls and this finds nothing to do. The ones that do not
   * — `table`, which assembles rows and cells directly — would otherwise leave
   * every row and cell with only the whole table's span. Descent is gated on an
   * exact child-count match at each level and stops the moment a node already
   * has a recording, so it can only ever narrow an inherited span, never
   * contradict a parsed one.
   */
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
        // A handler that returns an array in the same count as its mdast
        // children returned them in order (`state.all` preserves order), so
        // index alignment is sound and strictly sharper than the parent span.
        // This is the mark path: `toPmMark` re-marks every child into a fresh
        // object, which drops the child's own recording.
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

/**
 * Wrap a handler table so every node it produces is recorded when a recorder is
 * installed. Wrapping happens once, at `MarkdownManager` construction, because
 * the parse processor is frozen around the table; with an empty holder the
 * wrapper is one null check per node, which is why the map costs nothing to
 * have available and nothing to not use.
 */
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

/** Translates parse-time offsets back onto the bytes the caller passed in. */
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

/**
 * Walk one node's children, emitting a span each. Children with no recording
 * are bounded by their mapped neighbours rather than inheriting the parent's
 * whole span, so a synthesized blank-line paragraph between two real blocks
 * collapses onto the gap it actually occupies instead of swallowing both.
 */
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

/**
 * Deepest span containing `value` on the given axis.
 *
 * Spans nest and siblings are disjoint on both axes, so scanning back from the
 * last span that starts at or before `value`, the first one that also ends
 * after it is the innermost container: anything between it and `value` is a
 * subtree that already closed.
 */
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

/**
 * Interpolate inside a span. Equal lengths map char-for-char — the exact case,
 * and the one text runs land in unless the source escaped something. Otherwise
 * the offset is scaled, which keeps the landing inside the right node without
 * claiming a precision the span does not have.
 */
function interpolate(fromLen: number, toLen: number, rel: number, base: number): number {
  if (fromLen <= 0) return base;
  if (fromLen === toLen) return base + rel;
  return base + Math.round((rel / fromLen) * toLen);
}

/**
 * Extend a source range outward to whole lines.
 *
 * A leading BOM is not part of any line: it precedes the first block but a
 * splice that swallowed it would silently strip it from the file, which the
 * byte-stability guards would then report as a spurious diff.
 */
function toLineBounds(source: string, from: number, to: number): { from: number; to: number } {
  const floor = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  let start = clamp(from, floor, source.length);
  while (start > floor && source[start - 1] !== '\n') start--;
  let end = clamp(to, start, source.length);
  while (end < source.length && source[end] !== '\n') end++;
  return { from: start, to: end };
}

/**
 * Build the map from a parsed doc and the recordings its parse produced.
 *
 * `adjust` translates parse-time offsets back onto `source` — `parseMd` strips
 * a BOM and may dedent JSX close tags before handing bytes to remark, and both
 * shift every position downstream.
 */
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

/**
 * A map carrying only top-level block spans.
 *
 * The rebase path's output: exact where the write path reads it, and honest
 * about carrying nothing below that. `spans` and `blocks` are the same array,
 * so every lookup still answers — it just interpolates across a whole block
 * instead of across a text run.
 */
export function buildBlockSourceMap(
  blocks: readonly PmSourceSpan[],
  sourceLength: number,
  docSize: number,
): PmSourceMap {
  return sourceMapOverSpans([...blocks], { length: sourceLength }, docSize, 'block');
}

/** The shared query surface. `source` is read only for whole-line bounds. */
function sourceMapOverSpans(
  spans: PmSourceSpan[],
  source: string | { length: number },
  docSize: number,
  precision: PmSourceMapPrecision,
): PmSourceMap {
  const sourceLength = source.length;
  const text = typeof source === 'string' ? source : null;
  const blocks = spans.filter((span) => span.depth === 1);

  // The PM axis is already ascending in pre-order; the source axis is too for
  // every tree remark produces, but an inherited span can tie with its
  // neighbour, so sort explicitly and keep containers ahead of what they
  // contain (widest first) to preserve the nesting the search relies on.
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
      // A zero-width range is an INSERTION POINT, not a line. Blocks that emit
      // no markdown — an empty paragraph the user just made with Enter — hold a
      // zero-width span so the table keeps one entry per document block; widening
      // that to its enclosing line would make the next edit overwrite the
      // neighbour it sits against.
      if (head.sourceStart === tail.sourceEnd) {
        return { from: head.sourceStart, to: head.sourceStart };
      }
      // Without the bytes (a rebased map keeps none) the block span IS the line
      // range: rebase derives every span from a splice that was itself
      // line-bounded, so there is nothing left to widen.
      return text === null
        ? { from: head.sourceStart, to: tail.sourceEnd }
        : toLineBounds(text, head.sourceStart, tail.sourceEnd);
    },
  };
}
