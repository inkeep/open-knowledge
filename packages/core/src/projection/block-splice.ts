import { Fragment, type Node as PmNode } from '@tiptap/pm/model';
import { stripFrontmatter } from '../extensions/frontmatter.ts';
import type { MarkdownManager } from '../markdown/index.ts';
import {
  buildBlockSourceMap,
  type PmSourceMap,
  type PmSourceSpan,
} from '../markdown/pm-source-map.ts';

export interface SourceSplice {
  from: number;
  to: number;
  text: string;
}

export interface BlockRange {
  from: number;
  to: number;
}

export interface ChangedBlocks {
  before: BlockRange;
  after: BlockRange;
}

const MIN_WRITTEN_EDGE_EMPTIES = 2;

type ProjectionDeclineReason =
  | 'no-changed-blocks'
  | 'block-range-out-of-bounds'
  | 'after-range-out-of-bounds'
  | 'multi-block-change'
  | 'block-table-desynced'
  | 'missing-prefix-block'
  | 'all-newline-write'
  | 'missing-tail-block'
  | 'table-longer-than-doc'
  | 'unaccounted-doc-block'
  | 'unconsumed-table-blocks';

type ProjectionDeclineReporter = (
  reason: ProjectionDeclineReason,
  detail?: Readonly<Record<string, number>>,
) => void;

export interface Projection {
  readonly source: string;
  readonly bodyOffset: number;
  readonly doc: PmNode;
  readonly map: PmSourceMap;
}

export function buildProjection(source: string, md: MarkdownManager): Projection {
  const { frontmatter, body } = stripFrontmatter(source);
  const { doc, map } = md.parseWithSourceMapOrFallback(body);
  return { source, bodyOffset: frontmatter.length, doc, map };
}

/* STOP: a blank paragraph the source cannot spell must be HELD with a zero-width span, not
   left out of the table. map.blocks.length === doc.childCount is the contract every splice
   indexes through, and a leading run is the case that breaks it: one leading blank has no
   byte spelling at all, so the doc legitimately carries a block the parse never returns.
   Dropping it here costs the NEXT keystroke, which computeBlockSplice then declines. */
export function alignProjectionToDoc(
  projection: Projection,
  doc: PmNode,
  onDecline?: ProjectionDeclineReporter,
): Projection {
  const old = projection.map.blocks;
  if (old.length === doc.childCount) return { ...projection, doc };
  if (old.length > doc.childCount) {
    onDecline?.('table-longer-than-doc', { blocks: old.length, children: doc.childCount });
    return { ...projection, doc };
  }

  const bodyEnd = projection.map.sourceLength;
  const blocks: PmSourceSpan[] = [];
  let pos = 0;
  let taken = 0;
  let frontier = 0;
  for (let i = 0; i < doc.childCount; i++) {
    const child = doc.child(i);
    const from = pos;
    pos += child.nodeSize;
    if (isBlankParagraph(child) && doc.childCount - i > old.length - taken) {
      blocks.push({
        from,
        to: pos,
        sourceStart: frontier,
        sourceEnd: frontier,
        type: child.type.name,
        depth: 1,
        mapped: false,
      });
      continue;
    }
    const prior = old[taken];
    if (prior === undefined) {
      onDecline?.('unaccounted-doc-block', {
        index: i,
        blocks: old.length,
        children: doc.childCount,
      });
      return { ...projection, doc };
    }
    taken++;
    frontier = prior.sourceEnd;
    blocks.push({ ...prior, from, to: pos, type: child.type.name });
  }
  if (taken !== old.length) {
    onDecline?.('unconsumed-table-blocks', {
      taken,
      blocks: old.length,
      children: doc.childCount,
    });
    return { ...projection, doc };
  }
  return {
    ...projection,
    doc,
    map: buildBlockSourceMap(blocks, bodyEnd, doc.content.size),
  };
}

export function changedProjectionBlocks(before: PmNode, after: PmNode): ChangedBlocks | null {
  const beforeCount = before.childCount;
  const afterCount = after.childCount;
  const limit = Math.min(beforeCount, afterCount);

  let prefix = 0;
  while (prefix < limit && sameBlock(before.child(prefix), after.child(prefix))) prefix++;

  let suffix = 0;
  while (
    suffix < limit - prefix &&
    sameBlock(before.child(beforeCount - 1 - suffix), after.child(afterCount - 1 - suffix))
  ) {
    suffix++;
  }

  const range: ChangedBlocks = {
    before: { from: prefix, to: beforeCount - suffix },
    after: { from: prefix, to: afterCount - suffix },
  };
  if (range.before.from === range.before.to && range.after.from === range.after.to) return null;
  return range;
}

function sameBlock(a: PmNode, b: PmNode): boolean {
  return a === b || a.eq(b);
}

export function serializeBlockRange(doc: PmNode, range: BlockRange, md: MarkdownManager): string {
  const children: PmNode[] = [];
  for (let i = range.from; i < range.to; i++) children.push(doc.child(i));
  if (children.length === 0) return '';
  const slice = doc.type.create(
    { ...doc.attrs, sourceDocBoundary: null },
    Fragment.fromArray(children),
  );
  return md.serialize(slice.toJSON()).replace(/\n+$/, '');
}

function lineStart(source: string, offset: number): number {
  let at = Math.max(0, Math.min(offset, source.length));
  while (at > 0 && source[at - 1] !== '\n') at--;
  return at;
}

function lineEnd(source: string, offset: number): number {
  let at = Math.max(0, Math.min(offset, source.length));
  while (at < source.length && source[at] !== '\n') at++;
  return at;
}

export function computeBlockSplice(
  projection: Projection,
  after: PmNode,
  md: MarkdownManager,
  changed?: ChangedBlocks | null,
  onDecline?: ProjectionDeclineReporter,
): SourceSplice | null {
  const range = changed === undefined ? changedProjectionBlocks(projection.doc, after) : changed;
  if (range === null) {
    onDecline?.('no-changed-blocks', { children: after.childCount });
    return null;
  }

  const { map, bodyOffset, source } = projection;
  const body = source.slice(bodyOffset);
  const blocks = map.blocks;
  if (range.before.from < 0 || range.before.to > blocks.length) {
    onDecline?.('block-range-out-of-bounds', {
      beforeFrom: range.before.from,
      beforeTo: range.before.to,
      blocks: blocks.length,
      children: projection.doc.childCount,
    });
    return null;
  }
  if (range.after.to > after.childCount) {
    onDecline?.('after-range-out-of-bounds', {
      afterFrom: range.after.from,
      afterTo: range.after.to,
      children: after.childCount,
    });
    return null;
  }

  const text = serializeBlockRange(after, range.after, md);
  const shift = (offset: number): number => offset + bodyOffset;

  const bounds =
    range.before.from < range.before.to
      ? map.blockRangeToSourceRange(range.before.from, range.before.to)
      : null;
  const occupiesBytes = bounds !== null && bounds.to > bounds.from;

  if (text === '' && touchesBlankParagraphs(projection.doc, after, range)) {
    const gap = blankRunGapSplice(body, blocks, after, range, shift);
    if (gap !== null) return gap;
  }

  if (text === '' && occupiesBytes) {
    const { from, to } = bounds;
    if (range.before.to < blocks.length) {
      const next = blocks[range.before.to];
      return {
        from: shift(from),
        to: shift(next === undefined ? to : lineStart(body, next.sourceStart)),
        text: '',
      };
    }
    if (range.before.from > 0) {
      const prev = blocks[range.before.from - 1];
      return {
        from: shift(prev === undefined ? from : lineEnd(body, prev.sourceEnd)),
        to: shift(to),
        text: '',
      };
    }
    return { from: shift(from), to: shift(to), text: '' };
  }

  if (occupiesBytes) {
    return { from: shift(bounds.from), to: shift(bounds.to), text };
  }

  if (text !== '') {
    const anchored = blankRunAnchoredSplice(projection.doc, blocks, body, range, text, shift);
    if (anchored !== null) return anchored;
  }

  const anchor = insertionAnchor(body, blocks, range.before.from);

  if (text === '') {
    const point = shift(anchor?.point ?? 0);
    return { from: point, to: point, text: '' };
  }

  if (anchor === null) return { from: shift(0), to: shift(body.length), text };

  const point = shift(anchor.point);
  return {
    from: point,
    to: point,
    text: anchor.follows ? `\n\n${text}` : `${text}\n\n`,
  };
}

function isBlankParagraph(node: PmNode): boolean {
  return node.type.name === 'paragraph' && node.content.size === 0;
}

function touchesBlankParagraphs(before: PmNode, after: PmNode, range: ChangedBlocks): boolean {
  for (let i = range.after.from; i < range.after.to; i++) {
    if (!isBlankParagraph(after.child(i))) return false;
  }
  if (range.after.to > range.after.from) return true;
  for (let i = range.before.from; i < range.before.to && i < before.childCount; i++) {
    if (isBlankParagraph(before.child(i))) return true;
  }
  return false;
}

function blankRunGapSplice(
  body: string,
  blocks: readonly PmSourceSpan[],
  after: PmNode,
  range: ChangedBlocks,
  shift: (offset: number) => number,
): SourceSplice | null {
  let runStart = range.after.from;
  while (runStart > 0 && isBlankParagraph(after.child(runStart - 1))) runStart--;
  let runEnd = Math.max(range.after.to, range.after.from);
  while (runEnd < after.childCount && isBlankParagraph(after.child(runEnd))) runEnd++;
  const count = runEnd - runStart;

  const tailShift = range.after.to - range.before.to;
  const prev = runStart > 0 ? blocks[runStart - 1] : undefined;
  const next = runEnd < after.childCount ? blocks[runEnd - tailShift] : undefined;

  if (prev === undefined && next !== undefined) {
    return gapWrite(
      body,
      0,
      lineStart(body, next.sourceStart),
      '\n'.repeat(count >= MIN_WRITTEN_EDGE_EMPTIES ? count : 0),
      shift,
    );
  }
  if (prev !== undefined && next !== undefined) {
    return gapWrite(
      body,
      lineEnd(body, prev.sourceEnd),
      lineStart(body, next.sourceStart),
      '\n'.repeat(count + 2),
      shift,
    );
  }
  if (prev !== undefined) {
    return gapWrite(
      body,
      lineEnd(body, prev.sourceEnd),
      body.length,
      '\n'.repeat(count >= MIN_WRITTEN_EDGE_EMPTIES ? count + 1 : 1),
      shift,
    );
  }
  return null;
}

/* STOP: a held blank paragraph spells no bytes, so its span cannot anchor a write on its own.
   Rewriting the whole run region between the nearest blocks that do spell bytes is what keeps
   the block index and the source offset in agreement; anchoring on the last block with bytes
   writes the new content above the run instead of into it. */
function blankRunAnchoredSplice(
  before: PmNode,
  blocks: readonly PmSourceSpan[],
  body: string,
  range: ChangedBlocks,
  text: string,
  shift: (offset: number) => number,
): SourceSplice | null {
  let runStart = range.before.from;
  while (runStart > 0 && isBlankParagraph(before.child(runStart - 1))) runStart--;
  let runEnd = range.before.to;
  while (runEnd < before.childCount && isBlankParagraph(before.child(runEnd))) runEnd++;
  if (runStart === range.before.from && runEnd === range.before.to) return null;

  const prev = runStart > 0 ? blocks[runStart - 1] : undefined;
  if (prev !== undefined && prev.sourceEnd <= prev.sourceStart) return null;
  const next = runEnd < blocks.length ? blocks[runEnd] : undefined;

  const from = prev === undefined ? 0 : lineEnd(body, prev.sourceEnd);
  const to = next === undefined ? body.length : lineStart(body, next.sourceStart);
  if (to < from) return null;

  const lead = range.before.from - runStart;
  const trail = runEnd - range.before.to;
  const head =
    prev === undefined
      ? '\n'.repeat(lead >= MIN_WRITTEN_EDGE_EMPTIES ? lead : 0)
      : '\n'.repeat(lead + 2);
  const tail =
    next !== undefined
      ? '\n'.repeat(trail + 2)
      : '\n'.repeat(trail >= MIN_WRITTEN_EDGE_EMPTIES ? trail + 1 : 1);
  return { from: shift(from), to: shift(to), text: `${head}${text}${tail}` };
}

function gapWrite(
  body: string,
  from: number,
  to: number,
  text: string,
  shift: (offset: number) => number,
): SourceSplice | null {
  if (body.slice(from, to) === text) return null;
  return { from: shift(from), to: shift(to), text };
}

function insertionAnchor(
  body: string,
  blocks: readonly { sourceStart: number; sourceEnd: number }[],
  beforeFrom: number,
): { point: number; follows: boolean } | null {
  for (let i = Math.min(beforeFrom, blocks.length) - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block !== undefined && block.sourceEnd > block.sourceStart) {
      return { point: lineEnd(body, block.sourceEnd), follows: true };
    }
  }
  for (let i = Math.max(0, beforeFrom); i < blocks.length; i++) {
    const block = blocks[i];
    if (block !== undefined && block.sourceEnd > block.sourceStart) {
      return { point: lineStart(body, block.sourceStart), follows: false };
    }
  }
  return null;
}

export function applySplice(source: string, splice: SourceSplice): string {
  return source.slice(0, splice.from) + splice.text + source.slice(splice.to);
}

export function rebaseProjection(
  projection: Projection,
  after: PmNode,
  changed: ChangedBlocks,
  splice: SourceSplice,
  onDecline?: ProjectionDeclineReporter,
): Projection | null {
  if (changed.after.to - changed.after.from > 1) {
    onDecline?.('multi-block-change', {
      afterFrom: changed.after.from,
      afterTo: changed.after.to,
    });
    return null;
  }

  const oldBlocks = projection.map.blocks;
  /* STOP: map.blocks.length === doc.childCount is the contract every splice indexes through.
     A block whose source spells nothing must be held with a zero-width span
     (alignProjectionToDoc) rather than left out of the table, and a write that was declined
     must not be reported as made. A violation loses the NEXT keystroke, not this one. */
  if (oldBlocks.length !== projection.doc.childCount) {
    onDecline?.('block-table-desynced', {
      blocks: oldBlocks.length,
      children: projection.doc.childCount,
    });
    return null;
  }

  const source = applySplice(projection.source, splice);
  const sourceDelta = splice.text.length - (splice.to - splice.from);
  const spliceFrom = splice.from - projection.bodyOffset;
  const tailShift = changed.after.to - changed.before.to;

  const blocks: PmSourceSpan[] = [];
  let pos = 0;
  for (let i = 0; i < after.childCount; i++) {
    const child = after.child(i);
    const from = pos;
    pos += child.nodeSize;
    const span = { from, to: pos, type: child.type.name, depth: 1 };

    if (i < changed.after.from) {
      const old = oldBlocks[i];
      if (old === undefined) {
        onDecline?.('missing-prefix-block', { index: i, blocks: oldBlocks.length });
        return null;
      }
      blocks.push({
        ...span,
        sourceStart: old.sourceStart,
        sourceEnd: old.sourceEnd,
        mapped: old.mapped,
      });
      continue;
    }
    if (i < changed.after.to) {
      const written = splice.text;
      if (written !== '' && written.trim() === '') {
        onDecline?.('all-newline-write', { textLength: written.length });
        return null;
      }
      const lead = written.length - written.replace(/^\n+/, '').length;
      const trail = written.length - written.replace(/\n+$/, '').length;
      blocks.push({
        ...span,
        sourceStart: spliceFrom + lead,
        sourceEnd: spliceFrom + written.length - trail,
        mapped: true,
      });
      continue;
    }
    const old = oldBlocks[i - tailShift];
    if (old === undefined) {
      onDecline?.('missing-tail-block', { index: i - tailShift, blocks: oldBlocks.length });
      return null;
    }
    blocks.push({
      ...span,
      sourceStart: old.sourceStart + sourceDelta,
      sourceEnd: old.sourceEnd + sourceDelta,
      mapped: old.mapped,
    });
  }

  return {
    source,
    bodyOffset: projection.bodyOffset,
    doc: after,
    map: buildBlockSourceMap(blocks, source.length - projection.bodyOffset, after.content.size),
  };
}
