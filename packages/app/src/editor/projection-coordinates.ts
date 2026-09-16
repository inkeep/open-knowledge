import {
  buildProjection,
  computeSourceBlocks,
  type MarkdownManager,
  type PmSourceSpan,
  type Projection,
  type ProjectionUpdate,
  reprojectChanged,
} from '@inkeep/open-knowledge-core';
import type { Node as PmNode } from '@tiptap/pm/model';

/* STOP: `precision` is a contract, not a hint. A rebased map answers at block granularity and
   interpolates inside a block, so a consumer placing a character-accurate position must ask
   for a rebuild rather than read through a 'block' map. Every caller that needs a character
   position goes through this, never through `binding.stats.projection.map` directly. */
export function fullPrecisionProjection(projection: Projection, md: MarkdownManager): Projection {
  if (projection.map.precision === 'full') return projection;
  return buildProjection(projection.source, md);
}

interface FullPrecisionUpdate {
  full: Projection;
  previous: Projection | null;
  window: ProjectionUpdate | null;
}

export interface FullPrecisionResolver {
  (projection: Projection): Projection;
  readonly parses: () => number;
  readonly windows: () => number;
  readonly update: (source: string) => FullPrecisionUpdate;
  readonly reset: () => void;
}

/* STOP: the cache is only ever a projection this resolver built from the bytes, never one
   handed in. A caller's projection may carry the live document, which can hold what the source
   cannot spell; reparsing a window against that would splice the live document's divergence
   into a projection that claims to be the source's. */
export function createFullPrecisionResolver(
  md: MarkdownManager,
  seed?: Projection,
): FullPrecisionResolver {
  let cached: Projection | null = seed?.map.precision === 'full' ? seed : null;
  let parses = 0;
  let windows = 0;

  const update = (source: string): FullPrecisionUpdate => {
    const previous = cached;
    const window = previous === null ? null : reprojectChanged(previous, source, md);
    if (window !== null) {
      if (window.projection !== previous) windows++;
      cached = window.projection;
      return { full: window.projection, previous, window };
    }
    cached = buildProjection(source, md);
    parses++;
    return { full: cached, previous, window: null };
  };

  const resolve = (projection: Projection): Projection => {
    if (projection.map.precision === 'full') return projection;
    if (cached !== null && cached.source === projection.source) return cached;
    return update(projection.source).full;
  };

  const reset = (): void => {
    cached = null;
  };

  return Object.assign(resolve, { parses: () => parses, windows: () => windows, update, reset });
}

export function sourceOffsetToPmPos(projection: Projection, sourceOffset: number): number {
  return projection.map.sourceOffsetToPmPos(Math.max(0, sourceOffset - projection.bodyOffset));
}

/* STOP: the map resolves a CARET, so a span contains an offset only while `sourceEnd > offset`
   and an exclusive range end -- a block's `sourceEnd` -- matches no span and falls back to
   docSize. Resolving the last character and stepping over it is what keeps a range end inside
   the block it ends; mapping it as a caret paints from the change to the end of the document. */
export function sourceEndOffsetToPmPos(projection: Projection, sourceEndOffset: number): number {
  return sourceOffsetToPmPos(projection, sourceEndOffset - 1) + 1;
}

export function pmPosToSourceOffset(projection: Projection, pos: number): number {
  return projection.bodyOffset + projection.map.pmPosToSourceOffset(pos);
}

interface SpanPick {
  containing: PmSourceSpan | null;
  ending: PmSourceSpan | null;
  lastBefore: PmSourceSpan | null;
}

function pickSpans(
  spans: readonly PmSourceSpan[],
  value: number,
  startOf: (span: PmSourceSpan) => number,
  endOf: (span: PmSourceSpan) => number,
): SpanPick {
  let containing: PmSourceSpan | null = null;
  let ending: PmSourceSpan | null = null;
  let lastBefore: PmSourceSpan | null = null;
  for (const span of spans) {
    const start = startOf(span);
    const end = endOf(span);
    if (start <= value && end > value) {
      if (containing === null || span.depth > containing.depth) containing = span;
    } else if (end === value && (ending === null || span.depth > ending.depth)) {
      ending = span;
    }
    if (
      end <= value &&
      (lastBefore === null ||
        end > endOf(lastBefore) ||
        (end === endOf(lastBefore) && span.depth > lastBefore.depth))
    ) {
      lastBefore = span;
    }
  }
  return { containing, ending, lastBefore };
}

function endWins(pick: SpanPick): boolean {
  return (
    pick.ending !== null && (pick.containing === null || pick.ending.depth > pick.containing.depth)
  );
}

/* WARN: a block that spells nothing -- an empty paragraph inside a blank run -- carries a
   zero-width source span whose `to` is the position after its closing token, which belongs to
   the next block. Returning it puts the caret in the wrong paragraph. A text span's `to` is
   already a position a caret can occupy, so that one is returned as-is. */
function caretEndOfSpan(span: PmSourceSpan): number {
  if (span.sourceStart === span.sourceEnd && span.to - span.from >= 2) return span.from + 1;
  return span.to;
}

/* STOP: a caret is not a character. The map's intervals are half-open, so a caret resting at the
   exclusive end of a text span matches no span and resolves through the enclosing block instead,
   whose ProseMirror length counts its open and close tokens while its source length does not --
   the interpolation across that mismatch loses exactly one character. These two are inverses at
   every position, including block ends; `pmPosToSourceOffset` and `sourceOffsetToPmPos` are not,
   and using them for a caret puts a peer one character left of where they are, or, going the
   other way, at the end of the document. */
export function caretPmPosToSourceOffset(projection: Projection, pos: number): number {
  const pick = pickSpans(
    projection.map.spans,
    pos,
    (span) => span.from,
    (span) => span.to,
  );
  if (endWins(pick) && pick.ending !== null) return projection.bodyOffset + pick.ending.sourceEnd;
  return pmPosToSourceOffset(projection, pos);
}

/* STOP: a block's source span runs to the end of its line, trailing whitespace included, while
   its text span stops at the last character the parser kept. An offset in that trailing run
   belongs at the end of the block's text: resolving it through the block's own span puts it
   after the block's closing token, and TextSelection.near then carries it into the NEXT block. */
function trailingTextEnd(
  spans: readonly PmSourceSpan[],
  node: PmSourceSpan,
  value: number,
): number | null {
  if (node.type === 'text') return null;
  let last: PmSourceSpan | null = null;
  for (const span of spans) {
    if (span.depth <= node.depth || span.from < node.from || span.to > node.to) continue;
    if (span.sourceEnd > value) return null;
    if (span.type === 'text' && (last === null || span.to > last.to)) last = span;
  }
  return last === null ? null : last.to;
}

export function caretSourceOffsetToPmPos(projection: Projection, sourceOffset: number): number {
  const body = Math.max(0, sourceOffset - projection.bodyOffset);
  const { spans } = projection.map;
  const pick = pickSpans(
    spans,
    body,
    (span) => span.sourceStart,
    (span) => span.sourceEnd,
  );
  if (endWins(pick) && pick.ending !== null) {
    return trailingTextEnd(spans, pick.ending, body) ?? caretEndOfSpan(pick.ending);
  }
  if (pick.containing !== null) {
    const trailing = trailingTextEnd(spans, pick.containing, body);
    if (trailing !== null) return trailing;
  }
  if (pick.containing === null && pick.lastBefore !== null) {
    return trailingTextEnd(spans, pick.lastBefore, body) ?? caretEndOfSpan(pick.lastBefore);
  }
  return sourceOffsetToPmPos(projection, sourceOffset);
}

interface UnwrittenRun {
  start: number;
  endLive: number;
  endFull: number;
}

const unwrittenRuns = new WeakMap<PmNode, { full: PmNode; run: UnwrittenRun | null }>();

function samePositions(a: PmNode, b: PmNode): boolean {
  if (a.type.name !== b.type.name || a.nodeSize !== b.nodeSize) return false;
  if (a.isTextblock) return a.textContent === b.textContent;
  if (a.childCount !== b.childCount) return false;
  for (let i = 0; i < a.childCount; i++) {
    if (!samePositions(a.child(i), b.child(i))) return false;
  }
  return true;
}

/* STOP: the live document and a rebuild from the source are built in DIFFERENT schemas (the
   editor's and the MarkdownManager's), so ProseMirror's findDiffStart, which compares node types
   by identity, reports a difference at position 0 for identical documents. Compared here by type
   name, size and text. */
function unwrittenRun(live: PmNode, full: PmNode): UnwrittenRun | null {
  const found: Array<{ live: PmNode; full: PmNode; at: number }> = [];
  const walk = (a: PmNode, b: PmNode, contentStart: number): boolean => {
    if (a.childCount !== b.childCount) return false;
    let at = contentStart;
    for (let i = 0; i < a.childCount; i++) {
      const childA = a.child(i);
      const childB = b.child(i);
      if (!samePositions(childA, childB)) {
        if (childA.type.name !== childB.type.name || childA.isLeaf) return false;
        if (childA.isTextblock) {
          if (found.length > 0) return false;
          found.push({ live: childA, full: childB, at: at + 1 });
        } else if (!walk(childA, childB, at + 1)) {
          return false;
        }
      }
      at += childA.nodeSize;
    }
    return true;
  };
  const hit = walk(live, full, 0) ? found[0] : undefined;
  if (hit === undefined) return null;
  const leaf = '￼';
  const textLive = hit.live.textBetween(0, hit.live.content.size, undefined, leaf);
  const textFull = hit.full.textBetween(0, hit.full.content.size, undefined, leaf);
  if (textLive.length !== hit.live.content.size || textFull.length !== hit.full.content.size) {
    return null;
  }
  const shorter = Math.min(textLive.length, textFull.length);
  let prefix = 0;
  while (prefix < shorter && textLive[prefix] === textFull[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < shorter - prefix &&
    textLive[textLive.length - 1 - suffix] === textFull[textFull.length - 1 - suffix]
  ) {
    suffix++;
  }
  return {
    start: hit.at + prefix,
    endLive: hit.at + textLive.length - suffix,
    endFull: hit.at + textFull.length - suffix,
  };
}

/* STOP: a keystroke the source cannot spell yet -- a trailing space -- writes no bytes, so the
   live document holds characters that a full-precision rebuild from the source does not, and a
   live position read through that rebuild lands one block too far or one character too far
   right. The position is carried across the difference first. Only a difference inside one
   textblock is carried; anything wider keeps the plain mapping rather than guess. */
function unwrittenRunBetween(full: Projection, live: PmNode): UnwrittenRun | null {
  let cached = unwrittenRuns.get(live);
  if (cached === undefined || cached.full !== full.doc) {
    cached = { full: full.doc, run: unwrittenRun(live, full.doc) };
    unwrittenRuns.set(live, cached);
  }
  return cached.run;
}

export function liveToFullPos(full: Projection, live: PmNode, pos: number): number {
  if (live === full.doc) return pos;
  const run = unwrittenRunBetween(full, live);
  if (run === null) return pos;
  if (pos >= run.endLive) return pos - run.endLive + run.endFull;
  if (pos > run.start) return run.start;
  return pos;
}

/* STOP: the inverse of liveToFullPos, and just as required. A peer's offset resolved through the
   rebuild is a position in the rebuild, which is short by every character the local user typed
   that the source cannot spell yet; drawing it in the live document without carrying it back puts
   the peer one character left per unwritten character before them. A position at the start of the
   run stays before it: the peer never typed past the local user's unwritten characters. */
function fullToLivePos(full: Projection, live: PmNode, pos: number): number {
  if (live === full.doc) return pos;
  const run = unwrittenRunBetween(full, live);
  if (run === null) return pos;
  if (pos <= run.start) return pos;
  if (pos >= run.endFull) return pos - run.endFull + run.endLive;
  return run.start;
}

export function liveCaretPmPosToSourceOffset(full: Projection, live: PmNode, pos: number): number {
  return caretPmPosToSourceOffset(full, liveToFullPos(full, live, pos));
}

export function sourceOffsetToLiveCaretPos(
  full: Projection,
  live: PmNode,
  sourceOffset: number,
): number {
  return fullToLivePos(full, live, caretSourceOffsetToPmPos(full, sourceOffset));
}

export interface PmRange {
  from: number;
  to: number;
}

/* STOP: block ordinals and ProseMirror child ordinals are separate spaces and serialize is
   non-injective at the top level, so a block index is resolved to source offsets here and
   mapped through the byte map -- never indexed across the boundary with doc.child(i). The two
   spaces happen to agree for every parseable document measured, and stop agreeing the moment
   one does not parse (`computeSourceBlocks` yields no blocks; the projection yields one
   rawMdxFallback), which is exactly when a wrong range is painted over live prose. */
export function blockRangeToSourceRange(
  source: string,
  md: MarkdownManager,
  fromBlock: number,
  toBlock: number,
): { from: number; to: number } | null {
  const { blocks } = computeSourceBlocks(source, md);
  if (blocks.length === 0) return null;
  const first = Math.max(0, Math.min(fromBlock, blocks.length - 1));
  const last = Math.max(first, Math.min(toBlock, blocks.length) - 1);
  const start = blocks[first]?.sourceStart;
  const end = blocks[last]?.sourceEnd;
  if (typeof start !== 'number' || typeof end !== 'number') return null;
  if (end <= start) return null;
  return { from: start, to: end };
}

function sourceRangeToPmRange(
  projection: Projection,
  range: { from: number; to: number },
): PmRange | null {
  const size = projection.doc.content.size;
  const rawFrom = sourceOffsetToPmPos(projection, range.from);
  const rawTo = sourceEndOffsetToPmPos(projection, range.to);
  const from = Math.max(0, Math.min(rawFrom, size));
  const to = Math.max(from, Math.min(rawTo, size));
  if (to <= from) return null;
  return { from, to };
}

export function blockRangeToPmRange(
  projection: Projection,
  md: MarkdownManager,
  fromBlock: number,
  toBlock: number,
): PmRange | null {
  const sourceRange = blockRangeToSourceRange(projection.source, md, fromBlock, toBlock);
  if (sourceRange === null) return null;
  return sourceRangeToPmRange(projection, sourceRange);
}
