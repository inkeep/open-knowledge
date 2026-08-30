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

  // Replacement: the block range owns whole lines, so the splice is those lines.
  if (range.before.from < range.before.to && text !== '') {
    const bounds = map.blockRangeToSourceRange(range.before.from, range.before.to);
    if (bounds === null) return null;
    return { from: shift(bounds.from), to: shift(bounds.to), text };
  }

  // Deletion: take one separating blank run with the blocks, on whichever side
  // still has a neighbour, so removing a block cannot leave a wider gap behind.
  if (text === '') {
    const bounds = map.blockRangeToSourceRange(range.before.from, range.before.to);
    if (bounds === null) return null;
    if (range.before.to < blocks.length) {
      const next = blocks[range.before.to];
      return {
        from: shift(bounds.from),
        to: shift(next === undefined ? bounds.to : lineStart(body, next.sourceStart)),
        text: '',
      };
    }
    if (range.before.from > 0) {
      const prev = blocks[range.before.from - 1];
      return {
        from: shift(prev === undefined ? bounds.from : lineEnd(body, prev.sourceEnd)),
        to: shift(bounds.to),
        text: '',
      };
    }
    return { from: shift(bounds.from), to: shift(bounds.to), text: '' };
  }

  // Insertion: a zero-width write at a line boundary, carrying its own
  // separator on the side that has a neighbour.
  if (blocks.length === 0) return { from: shift(0), to: shift(body.length), text };
  if (range.before.from < blocks.length) {
    const at = blocks[range.before.from];
    if (at === undefined) return null;
    const point = shift(lineStart(body, at.sourceStart));
    return { from: point, to: point, text: `${text}\n\n` };
  }
  const last = blocks[blocks.length - 1];
  if (last === undefined) return null;
  const point = shift(lineEnd(body, last.sourceEnd));
  return { from: point, to: point, text: `\n\n${text}` };
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
