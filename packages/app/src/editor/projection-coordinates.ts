import {
  buildProjection,
  computeSourceBlocks,
  type MarkdownManager,
  type PmSourceSpan,
  type Projection,
} from '@inkeep/open-knowledge-core';

/* STOP: `precision` is a contract, not a hint. A rebased map answers at block granularity and
   interpolates inside a block, so a consumer placing a character-accurate position must ask
   for a rebuild rather than read through a 'block' map. Every caller that needs a character
   position goes through this, never through `binding.stats.projection.map` directly. */
export function fullPrecisionProjection(projection: Projection, md: MarkdownManager): Projection {
  if (projection.map.precision === 'full') return projection;
  return buildProjection(projection.source, md);
}

export interface FullPrecisionResolver {
  (projection: Projection): Projection;
  readonly parses: () => number;
}

export function createFullPrecisionResolver(md: MarkdownManager): FullPrecisionResolver {
  let cachedSource: string | null = null;
  let cached: Projection | null = null;
  let parses = 0;

  const resolve = (projection: Projection): Projection => {
    if (projection.map.precision === 'full') return projection;
    if (cached !== null && cachedSource === projection.source) return cached;
    const full = buildProjection(projection.source, md);
    parses++;
    cachedSource = projection.source;
    cached = full;
    return full;
  };

  return Object.assign(resolve, { parses: () => parses });
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

export function caretSourceOffsetToPmPos(projection: Projection, sourceOffset: number): number {
  const body = Math.max(0, sourceOffset - projection.bodyOffset);
  const pick = pickSpans(
    projection.map.spans,
    body,
    (span) => span.sourceStart,
    (span) => span.sourceEnd,
  );
  if (endWins(pick) && pick.ending !== null) return caretEndOfSpan(pick.ending);
  if (pick.containing === null && pick.lastBefore !== null) return caretEndOfSpan(pick.lastBefore);
  return sourceOffsetToPmPos(projection, sourceOffset);
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
