/**
 * Block-scoped write path for the local WYSIWYG projection.
 *
 * In the single-CRDT target the ProseMirror document is a per-client read model
 * of `Y.Text('source')`, and a WYSIWYG edit has to become a `Y.Text` write under
 * the user's own origin. This module is that translation, and it is deliberately
 * the *smallest* one that works: it never reasons about what the user did, only
 * about which top-level blocks are no longer the ones that were there before.
 *
 * ## Why block-scoped rather than whole-document
 *
 * The server-side bridge re-serializes the entire document per drain and
 * line-diffs the result. That is measured at 181 ms on a 488 KB document and
 * 368 ms at 977 KB, against 0.05 ms — flat at every size — for a single block.
 * Scoping is therefore a requirement, not an optimisation.
 *
 * It is also *better for byte stability*, which is the less obvious half. A
 * whole-document serialize renormalizes blocks the user never touched
 * (`[**Desktop**](x)` becomes `**[Desktop](x)**`), so those bytes change on
 * disk and show up as spurious git diffs. Serializing one block cannot: every
 * byte outside the replaced line range is copied through untouched.
 *
 * The corollary is how this module must be TESTED. "Serialize the whole edited
 * document" is not a valid oracle — it disagrees with a correct block splice
 * about 10% of the time, and every disagreement is the oracle renormalizing.
 * Assert containment (nothing outside the block range moved) and re-parse
 * fidelity (the edit landed, other blocks did not change) instead.
 *
 * ## Why identity is enough to find the edited block
 *
 * ProseMirror nodes are persistent: a transaction rebuilds only the spine it
 * touched and shares every other node object. So the longest common prefix and
 * suffix under `===` finds the changed range in O(childCount) pointer
 * comparisons, with no dependence on step shapes or on `prosemirror-state`.
 * `eq()` is the fallback for documents that were not produced from each other
 * by a transaction (a rebuilt projection, say), where identity would report the
 * whole document as changed.
 */

import { Fragment, type Node as PmNode } from '@tiptap/pm/model';
import { stripFrontmatter } from '../extensions/frontmatter.ts';
import { MIN_CARRIED_EDGE_EMPTIES } from '../markdown/doc-edge-blank-runs.ts';
import type { MarkdownManager } from '../markdown/index.ts';
import {
  buildBlockSourceMap,
  type PmSourceMap,
  type PmSourceSpan,
} from '../markdown/pm-source-map.ts';

/** A contiguous rewrite of the markdown source, in full-source char offsets. */
export interface SourceSplice {
  /** Start of the replaced range. */
  from: number;
  /** End of the replaced range, exclusive. `from === to` is an insertion. */
  to: number;
  /** Replacement bytes. Empty is a deletion. */
  text: string;
}

/** A half-open range of top-level block ordinals. */
export interface BlockRange {
  from: number;
  to: number;
}

/** What changed between two revisions of the projected document. */
export interface ChangedBlocks {
  /** Ordinals in the document as it was. Empty (`from === to`) is an insertion. */
  before: BlockRange;
  /** Ordinals in the document as it now is. Empty is a deletion. */
  after: BlockRange;
}

/**
 * The projected document, the source it was projected from, and the map between
 * them.
 *
 * `map` addresses the BODY — the parse pipeline has no frontmatter plugin, so
 * the fence would parse as a thematic break — while a splice is applied to the
 * full `Y.Text`. `bodyOffset` is the one place that difference is reconciled;
 * everything this module returns is already in full-source coordinates.
 */
export interface Projection {
  /** The full `Y.Text('source')` string, frontmatter included. */
  readonly source: string;
  /** Char offset where the body begins; 0 when there is no frontmatter. */
  readonly bodyOffset: number;
  readonly doc: PmNode;
  /** Body-relative map. Add `bodyOffset` to cross into full-source offsets. */
  readonly map: PmSourceMap;
}

/** Project a `Y.Text` snapshot into a ProseMirror document plus its byte map. */
export function buildProjection(source: string, md: MarkdownManager): Projection {
  const { frontmatter, body } = stripFrontmatter(source);
  const { doc, map } = md.parseWithSourceMap(body);
  return { source, bodyOffset: frontmatter.length, doc, map };
}

/**
 * The top-level block ordinals that differ between two revisions.
 *
 * Null when the documents' top levels are identical — the common case for a
 * transaction that only moved the selection, and the caller's signal to write
 * nothing at all rather than to write bytes equal to the ones already there.
 */
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

/** Identity first — a transaction shares every node it did not rebuild. */
function sameBlock(a: PmNode, b: PmNode): boolean {
  return a === b || a.eq(b);
}

/**
 * Markdown for a range of top-level blocks, and nothing else.
 *
 * The slice is serialized as its own document, with `sourceDocBoundary` cleared:
 * that attribute replays the whole file's leading and trailing blank runs, which
 * belong to the document, not to any block inside it, and would otherwise be
 * re-emitted around every splice.
 */
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

/**
 * The `Y.Text` splice that carries one WYSIWYG edit.
 *
 * Returns null when nothing changed, and when the edit falls outside the block
 * table the projection was built from — a caller that has drifted must rebuild
 * the projection rather than splice against a stale map.
 *
 * The three shapes are kept distinct on purpose. A replacement rewrites whole
 * lines. An insertion writes at a line boundary and brings its own blank-line
 * separator, because the separator is not part of any block's span. A deletion
 * takes the separator with it, or the document grows a blank run every time a
 * block is removed.
 */
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

  // The bytes the replaced blocks occupy. Zero-width when the edit inserts
  // between blocks, and ALSO when the blocks being replaced are themselves
  // zero-emission — both are insertion points, and both must take the
  // separator-carrying path below rather than the line-replacing one.
  const bounds =
    range.before.from < range.before.to
      ? map.blockRangeToSourceRange(range.before.from, range.before.to)
      : null;
  const occupiesBytes = bounds !== null && bounds.to > bounds.from;

  // Deletion: take one separating blank run with the blocks, on whichever side
  // still has a neighbour, so removing a block cannot leave a wider gap behind.
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

  // Replacement: the block range owns whole lines, so the splice is those lines.
  if (occupiesBytes) {
    return { from: shift(bounds.from), to: shift(bounds.to), text };
  }

  // Everything below writes at a POINT: either between two blocks, or into the
  // slot a zero-emission block already holds.
  const anchor = insertionAnchor(body, blocks, range.before.from);

  // Zero-emission: the new blocks serialize to nothing, so there is nothing to
  // write. An empty paragraph — what Enter produces before anything is typed
  // into it — has no markdown spelling; markdown can only express a blank line
  // as a wider gap between two blocks that DO emit. Returning an empty
  // zero-width splice says "the document changed, the bytes did not": the caller
  // keeps the block in its projection (holding a zero-width span, so the table
  // still has one entry per document block) and writes nothing. The block
  // materializes into real bytes the moment it gets content.
  //
  // Silently dropping this case instead is what made Enter appear to do nothing:
  // the empty paragraph could not be placed, the projection rebuilt from the
  // unchanged markdown, and the user's new line vanished as they made it.
  if (text === '') {
    // ...unless it is a run of blank paragraphs between blocks that DO emit.
    // Markdown spells that as a wider gap, so it is writable after all — just
    // not by serializing the blank blocks, which emit nothing however many of
    // them there are. Widening the gap is also byte-minimal: it rewrites only
    // the newlines between two blocks, never the neighbours themselves.
    const gap = blankRunGapSplice(body, blocks, after, range, shift);
    if (gap !== null) return gap;
    const point = shift(anchor?.point ?? 0);
    return { from: point, to: point, text: '' };
  }

  // Nothing else in the document emits anything, so the insertion IS the
  // document and there is no neighbour to separate from.
  if (anchor === null) return { from: shift(0), to: shift(body.length), text };

  // The blank-line separator belongs to no block's span, so an insertion has to
  // bring its own — on the side the anchor was taken from. Point and side are
  // one decision: a separator on the far side of the anchor from the neighbour
  // it was measured against lands the text inside that neighbour's gap instead
  // of beside it.
  const point = shift(anchor.point);
  return {
    from: point,
    to: point,
    text: anchor.follows ? `\n\n${text}` : `${text}\n\n`,
  };
}

/** A top-level block that renders as a blank line and emits no markdown. */
function isBlankParagraph(node: PmNode): boolean {
  return node.type.name === 'paragraph' && node.content.size === 0;
}

/**
 * Express a run of blank paragraphs as the gap between its emitting neighbours.
 *
 * `insertInteriorBlankRunParagraphs` reads N blank paragraphs back out of a
 * gap of N+2 newlines, and the doc-edge pass reads them out of N+1 TRAILING
 * newlines — but only from `MIN_CARRIED_EDGE_EMPTIES` up, because below that
 * floor a trailing empty paragraph is indistinguishable from the type-here
 * affordance the editor renders after the last block. So the write here is
 * arithmetic on newlines, not serialization: the blank blocks themselves emit
 * nothing at any count.
 *
 * The run is re-derived from the CURRENT document rather than taken from the
 * changed range, because adding one blank line to an existing run changes one
 * block but must rewrite the whole run's gap.
 *
 * Null when the run cannot be spelled: no emitting neighbour on either side, a
 * leading run (whose boundary capture this does not yet handle), or a trailing
 * run below the floor. Those stay held in the projection, unwritten.
 */
function blankRunGapSplice(
  body: string,
  blocks: readonly PmSourceSpan[],
  after: PmNode,
  range: ChangedBlocks,
  shift: (offset: number) => number,
): SourceSplice | null {
  if (range.after.to <= range.after.from) return null;
  for (let i = range.after.from; i < range.after.to; i++) {
    if (!isBlankParagraph(after.child(i))) return null;
  }

  let runStart = range.after.from;
  while (runStart > 0 && isBlankParagraph(after.child(runStart - 1))) runStart--;
  let runEnd = range.after.to;
  while (runEnd < after.childCount && isBlankParagraph(after.child(runEnd))) runEnd++;
  const count = runEnd - runStart;

  // Blocks outside the changed range line up index-for-index with the block
  // table, shifted past the change by however much the range grew.
  const tailShift = range.after.to - range.before.to;
  const prev = runStart > 0 ? blocks[runStart - 1] : undefined;
  const next = runEnd < after.childCount ? blocks[runEnd - tailShift] : undefined;

  if (prev !== undefined && next !== undefined) {
    return {
      from: shift(lineEnd(body, prev.sourceEnd)),
      to: shift(lineStart(body, next.sourceStart)),
      text: '\n'.repeat(count + 2),
    };
  }
  if (prev !== undefined) {
    if (count < MIN_CARRIED_EDGE_EMPTIES) return null;
    return {
      from: shift(lineEnd(body, prev.sourceEnd)),
      to: shift(body.length),
      text: '\n'.repeat(count + 1),
    };
  }
  return null;
}

/**
 * Where a point-write lands, and which side of it the separator goes.
 *
 * `follows` means the point was taken from the END of a preceding block, so the
 * text comes after the separator; otherwise it was taken from the START of a
 * following block and the separator comes after the text. Returning them
 * together is the point of this helper — they were separate once, and the text
 * landed on the wrong side of the gap.
 *
 * Blocks that emit nothing are skipped on both scans: they hold no bytes to
 * anchor against, so anchoring to one would place the write at an offset that
 * describes no line.
 */
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

/** Apply a splice to the source it was computed against. */
export function applySplice(source: string, splice: SourceSplice): string {
  return source.slice(0, splice.from) + splice.text + source.slice(splice.to);
}

/**
 * The projection that results from applying a splice, without re-parsing.
 *
 * This is what keeps a keystroke off the O(document) path. Everything the write
 * path reads is a top-level block span, and after a splice each one is known
 * exactly: blocks before the edit did not move, blocks after it moved by a
 * constant, and the replaced block occupies the bytes the splice just wrote.
 * No parse is involved, so the cost is the `serializeBlockRange` that produced
 * the splice — measured flat at 0.05 ms against 181 ms for a whole-document
 * serialize at 488 KB, and against a 911 ms parse.
 *
 * The resulting map is `precision: 'block'`. Spans below the top level are not
 * carried, because deriving them WOULD need a parse; a consumer that needs
 * character accuracy (cursor placement on a mode switch) should check
 * `map.precision` and call `buildProjection` instead of interpolating across a
 * whole block.
 *
 * Returns null when the edit replaced more than one block at once. The bytes of
 * a multi-block splice cannot be subdivided back into per-block spans without
 * parsing them — remark chooses the separator between two blocks, so it is not
 * simply `\n\n` — and guessing there would put every span after it off by
 * however much the guess missed. Rebuild instead; it is the rare case.
 */
export function rebaseProjection(
  projection: Projection,
  after: PmNode,
  changed: ChangedBlocks,
  splice: SourceSplice,
): Projection | null {
  if (changed.after.to - changed.after.from > 1) return null;

  const oldBlocks = projection.map.blocks;
  if (oldBlocks.length !== projection.doc.childCount) return null;

  const source = applySplice(projection.source, splice);
  const sourceDelta = splice.text.length - (splice.to - splice.from);
  // Block spans are body-relative (the parse never sees the frontmatter fence,
  // which would parse as a thematic break); splices are full-source. Do the
  // whole rebase in body coordinates and cross over once, here.
  const spliceFrom = splice.from - projection.bodyOffset;
  // Old index of the block that now sits at new index `i`, for the untouched
  // tail: the two ranges share a suffix, so the offset is the size difference.
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
      // The one rewritten block owns exactly the bytes the splice wrote, minus
      // the blank-line separator an insertion brought with it.
      const written = splice.text;
      // A whitespace-only rewrite is a blank-run gap, whose blocks occupy no
      // bytes and whose parsed positions the newline arithmetic here cannot
      // reproduce. Decline and let the caller re-derive from the markdown.
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
