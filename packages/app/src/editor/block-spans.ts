/**
 * Top-level block-ordinal coordinate substrate shared by the WYSIWYG lint
 * decorations and cross-mode position mapping.
 *
 * Both surfaces need the same primitive: the alignment between the body's mdast
 * top-level blocks and the PM doc's top-level nodes. That alignment is NOT
 * guaranteed. The bridge invariant is a byte check on the serialize side only,
 * and on the WYSIWYG write path the fragment is the mutated structure — it is
 * never re-derived via parse. Because `serialize` is non-injective at the top
 * level, a WYSIWYG-authored fragment can hold shapes markdown cannot spell —
 * adjacent same-kind `list` siblings, interior empty paragraphs — which
 * `parse` merges or drops, shifting every ordinal after the collapse. Such
 * divergence is PERSISTENT (it survives Observer A and persistence), not a
 * mid-drain transient.
 *
 * The count-equality tripwire (`comparableChildCount`) detects a shifted count
 * but is necessary, not sufficient: equal counts do not prove identity
 * alignment. A consumer must not index an ordinal across the representation
 * boundary when the tripwire fails — refuse the pass or re-locate by content;
 * never index through. This module is intentionally dependency-light (no
 * React, no floating-ui) so the resolver can build on it without dragging in a
 * decoration plugin's module graph.
 */

import {
  type MarkdownManager,
  MIN_CARRIED_EDGE_EMPTIES,
  stripFrontmatter,
} from '@inkeep/open-knowledge-core';
import type { Node as PmNode } from '@tiptap/pm/model';

/** 1-based inclusive line spans of top-level body blocks, in full-source coordinates. */
export interface SourceBlockSpans {
  spans: { start: number; end: number }[];
  /** Lines the frontmatter region occupies at the top of the source (0 when none). */
  fmLineCount: number;
}

/** A top-level source block enriched with the fields the position resolver grades on. */
export interface SourceBlock {
  /** 1-based inclusive line span in full-source coordinates. */
  start: number;
  end: number;
  /** Canonical block kind, normalized across the mdast and PM vocabularies. */
  kind: string;
  /** Plain text content (markdown syntax stripped), for content-equality checks. */
  text: string;
}

/**
 * Normalize a mdast or ProseMirror node-type name to a shared block-kind
 * vocabulary so a block captured in one representation can be type-matched
 * against the other. mdast and PM disagree on several names for the same
 * construct (`list` vs `bulletList`/`orderedList`, `code` vs `codeBlock`,
 * `thematicBreak` vs `horizontalRule`); unknown names pass through unchanged so
 * an exact name match still counts.
 */
export function canonicalBlockKind(typeName: string): string {
  switch (typeName) {
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
    case 'list':
      return 'list';
    case 'codeBlock':
    case 'code':
      return 'code';
    case 'horizontalRule':
    case 'thematicBreak':
      return 'thematicBreak';
    case 'jsxComponent':
    case 'mdxJsxFlowElement':
    case 'mdxJsxTextElement':
      return 'jsx';
    case 'htmlBlock':
    case 'html':
      return 'html';
    default:
      return typeName;
  }
}

/**
 * Concatenate the visible text of an mdast node (its descendant literal values),
 * the mdast counterpart of ProseMirror's `node.textContent`. Kept structural
 * (walks `value`/`children` without an mdast type import) so this leaf module
 * stays free of the `mdast` dependency.
 */
function mdastText(node: unknown): string {
  if (typeof node !== 'object' || node === null) return '';
  if ('value' in node && typeof node.value === 'string') return node.value;
  if ('children' in node && Array.isArray(node.children)) {
    return node.children.map(mdastText).join('');
  }
  return '';
}

/**
 * Top-level body blocks for a full `Y.Text('source')` snapshot. The body region
 * (after the FM fence) is parsed to mdast; line spans are shifted back into
 * full-source coordinates so full-source line numbers index into them directly.
 * The single positioned parse the resolver relies on.
 */
export function computeSourceBlocks(
  source: string,
  md: MarkdownManager,
): { blocks: SourceBlock[]; fmLineCount: number } {
  const { frontmatter, body } = stripFrontmatter(source);
  const fmLineCount = frontmatter === '' ? 0 : frontmatter.split('\n').length - 1;
  // The editor view, not the CommonMark one: a preserved blank line is a
  // paragraph in the PM doc, and this array is index-aligned with those
  // children. Losing the alignment silently disables every decoration and
  // strands the count tripwire.
  //
  // `parseToEditorMdast` throws on structurally invalid MDX (an unclosed or mismatched
  // JSX tag) — a routine transient state while editing raw source. Every consumer
  // (the lint decorations and the mode-switch resolver) already treats an empty
  // block list as "no anchor", so degrading to no blocks reproduces the
  // pre-feature no-op flip. A synchronous throw would be worse than a lost anchor:
  // the toggle captures the source block before the mode flips, so it would abort
  // the flip and strand the user in the mode they were leaving.
  try {
    const blocks = md.parseToEditorMdast(body).children.map((child) => ({
      start: (child.position?.start.line ?? Number.POSITIVE_INFINITY) + fmLineCount,
      end: (child.position?.end.line ?? Number.NEGATIVE_INFINITY) + fmLineCount,
      kind: canonicalBlockKind(child.type),
      text: mdastText(child),
    }));
    return { blocks, fmLineCount };
  } catch {
    // Leave a breadcrumb: the no-blocks degradation is indistinguishable from a
    // genuinely empty body downstream, and a systematic parse regression on
    // valid markdown would silently send every mode switch to the top of the
    // document with nothing to find. Raw `performance.mark` rather than the
    // `mark()` helper keeps this leaf free of the perf module's graph; the name
    // follows the same ok/<subsystem>/<event> convention.
    performance.mark('ok/block-spans/parse-failed');
    return { blocks: [], fmLineCount };
  }
}

/**
 * Line spans for a full `Y.Text('source')` snapshot — the projection of
 * `computeSourceBlocks` that lint diagnostics (which carry full-source lines —
 * markdownlint skips the FM region itself) index into directly.
 */
export function computeSourceBlockSpans(source: string, md: MarkdownManager): SourceBlockSpans {
  const { blocks, fmLineCount } = computeSourceBlocks(source, md);
  return { spans: blocks.map((b) => ({ start: b.start, end: b.end })), fmLineCount };
}

/**
 * Map a 1-based full-source line to a top-level block index. Lines inside a
 * block map to it; between-block lines (blank-line runs — where rules like
 * MD012 report) anchor to the NEXT block; lines past the last block anchor to
 * the last one. Null only when there are no blocks at all.
 *
 * Spans are ascending and non-overlapping (mdast top-level positions), so a
 * binary search for the first span whose end is at or after the line yields
 * both the containing case and the gap-anchors-to-next case in one probe: that
 * span contains the line when its start is also below it, and is the next block
 * otherwise. A line past every span's end falls through to the last block.
 */
export function blockIndexForLine(spans: SourceBlockSpans['spans'], line: number): number | null {
  if (spans.length === 0) return null;
  let lo = 0;
  let hi = spans.length - 1;
  let candidate = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const span = spans[mid];
    if (span !== undefined && span.end >= line) {
      candidate = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return candidate;
}

/**
 * Top-level child count comparable against body block spans.
 *
 * Two different things can put an empty paragraph at the end of the PM doc,
 * and only one of them has a source counterpart. A doc whose last block isn't
 * a paragraph renders with the type-here affordance below that final
 * heading/list, which the source does not spell. A doc-edge blank run the user
 * authored does reach the source, and parse gives it back as the same empty
 * paragraphs — but only from `MIN_CARRIED_EDGE_EMPTIES` up; below the floor a
 * run stays on the boundary snapshot and yields no block, precisely because at
 * one paragraph it is indistinguishable from the affordance.
 *
 * So the floor is also the discriminator: a trailing empty run shorter than it
 * has no source blocks behind it and must come off the count, while a run at or
 * above it is matched paragraph-for-paragraph and must not. Getting this wrong
 * fails silently — the span↔doc comparison would fail PERMANENTLY on every
 * affected doc, disabling decorations and navigation with no error.
 */
export function comparableChildCount(doc: PmNode): number {
  let trailingEmpty = 0;
  for (let i = doc.childCount - 1; i >= 0; i--) {
    const child = doc.child(i);
    if (child.type.name !== 'paragraph' || child.content.size !== 0) break;
    trailingEmpty++;
  }
  return trailingEmpty < MIN_CARRIED_EDGE_EMPTIES ? doc.childCount - trailingEmpty : doc.childCount;
}

/**
 * ProseMirror positions spanning top-level blocks `[fromBlock, toBlock)`: from
 * the boundary before the first block through the boundary after the last. Block
 * indices address PM top-level nodes directly (y-prosemirror mirrors the
 * XmlFragment's children onto the PM doc). Both ends are clamped to the document
 * size; null when the range is empty or falls entirely outside the document. The
 * PM-position sibling of the line-and-offset helpers below.
 */
export function blockRangeToPositions(
  doc: PmNode,
  fromBlock: number,
  toBlock: number,
): { from: number; to: number } | null {
  const childCount = doc.childCount;
  const first = Math.max(0, Math.min(fromBlock, childCount));
  const last = Math.max(first, Math.min(toBlock, childCount));
  if (last <= first) return null;
  let pos = 0;
  for (let i = 0; i < first; i++) pos += doc.child(i).nodeSize;
  const from = pos;
  for (let i = first; i < last; i++) pos += doc.child(i).nodeSize;
  const to = pos;
  const size = doc.content.size;
  const clampedFrom = Math.max(0, Math.min(from, size));
  const clampedTo = Math.max(clampedFrom, Math.min(to, size));
  if (clampedTo <= clampedFrom) return null;
  return { from: clampedFrom, to: clampedTo };
}

/**
 * Char offset where each 1-based line begins. `offsets[i]` is the start of line
 * `i + 1`; index 0 is always 0. Used to convert the line-based block spans into
 * the full `Y.Text` char offsets that cross the resolver's boundary.
 */
export function lineStartOffsets(source: string): number[] {
  const offsets = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

/** Full-source char offset of the start of a 1-based line, clamped to the source. */
export function lineToOffset(offsets: number[], line: number, sourceLength: number): number {
  if (line <= 1) return 0;
  if (line - 1 >= offsets.length) return sourceLength;
  return offsets[line - 1] ?? sourceLength;
}

/** 1-based line containing a full-source char offset. */
export function offsetToLine(offsets: number[], offset: number): number {
  // offsets is ascending; find the last line start <= offset.
  let lo = 0;
  let hi = offsets.length - 1;
  let line = 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((offsets[mid] ?? 0) <= offset) {
      line = mid + 1;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return line;
}
