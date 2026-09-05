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

const MIN_WRITTEN_TRAILING_EMPTIES = 2;

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

export function alignProjectionToDoc(projection: Projection, doc: PmNode): Projection {
  const old = projection.map.blocks;
  if (old.length === doc.childCount) return { ...projection, doc };
  if (old.length > doc.childCount) return { ...projection, doc };
  for (let i = old.length; i < doc.childCount; i++) {
    const child = doc.child(i);
    if (child.type.name !== 'paragraph' || child.content.size !== 0) {
      return { ...projection, doc };
    }
  }

  const bodyEnd = projection.map.sourceLength;
  const blocks: PmSourceSpan[] = [];
  let pos = 0;
  for (let i = 0; i < doc.childCount; i++) {
    const child = doc.child(i);
    const from = pos;
    pos += child.nodeSize;
    const prior = old[i];
    blocks.push(
      prior !== undefined
        ? { ...prior, from, to: pos, type: child.type.name }
        : {
            from,
            to: pos,
            sourceStart: bodyEnd,
            sourceEnd: bodyEnd,
            type: child.type.name,
            depth: 1,
            mapped: false,
          },
    );
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
): SourceSplice | null {
  const range = changed === undefined ? changedProjectionBlocks(projection.doc, after) : changed;
  if (range === null) return null;

  const { map, bodyOffset, source } = projection;
  const body = source.slice(bodyOffset);
  const blocks = map.blocks;
  if (range.before.from < 0 || range.before.to > blocks.length) return null;
  if (range.after.to > after.childCount) return null;

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
      '\n'.repeat(count >= MIN_WRITTEN_TRAILING_EMPTIES ? count + 1 : 1),
      shift,
    );
  }
  return null;
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
): Projection | null {
  if (changed.after.to - changed.after.from > 1) return null;

  const oldBlocks = projection.map.blocks;
  /* STOP: map.blocks.length === doc.childCount is the contract every splice indexes through.
     A block whose source spells nothing must be held with a zero-width span
     (alignProjectionToDoc) rather than left out of the table, and a write that was declined
     must not be reported as made. A violation loses the NEXT keystroke, not this one. */
  if (oldBlocks.length !== projection.doc.childCount) return null;

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
      if (old === undefined) return null;
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
      if (written !== '' && written.trim() === '') return null;
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
    if (old === undefined) return null;
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
