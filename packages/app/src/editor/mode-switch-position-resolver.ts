/**
 * Cross-representation position mapping for mode switches.
 *
 * The editor renders one document through two representations — a ProseMirror
 * doc (WYSIWYG) and a `Y.Text('source')` string (frontmatter + body). A mode
 * switch must carry the user's place from one to the other, but the two use
 * different coordinate spaces and both report virtualization-estimated geometry,
 * so raw scroll position is meaningless across the flip.
 *
 * This module is the single chokepoint for that mapping: it turns a captured
 * top-level-block anchor into a resolved position in the other representation,
 * with a graded confidence, holding no document reference and performing no
 * writes. Everything it does is a pure function of the snapshots the caller
 * supplies at resolve time, so the whole feature's coordinate logic stays behind
 * this one interface — a future byte-accurate map can reimplement the two
 * methods without touching any consumer. Block-level granularity is deliberate:
 * ordinals are virtualization-independent where a pixel-proportional mapping is
 * not, and they need no per-node source-byte map to compute.
 */

import type { MarkdownManager } from '@inkeep/open-knowledge-core';
import type { Node as PmNode } from '@tiptap/pm/model';
import {
  blockIndexForLine,
  blockRangeToPositions,
  canonicalBlockKind,
  comparableChildCount,
  computeSourceBlocks,
  lineStartOffsets,
  lineToOffset,
  offsetToLine,
  type SourceBlock,
} from './block-spans';

/**
 * How much the resolver trusts a landing, most to least precise. `exact` is the
 * only grade at which an inline (within-block) refinement is trustworthy;
 * `clamped` means the block ordinal fell outside the target and the landing was
 * pulled to the nearest block. The caller suppresses the highlight on both
 * `clamped` and `ordinal` — neither is content- or kind-verified (see
 * `clampFlashRange`).
 */
export type ResolveConfidence = 'exact' | 'same-type-ordinal' | 'ordinal' | 'clamped';

export const CONFIDENCE_ORDER = [
  'exact',
  'same-type-ordinal',
  'ordinal',
  'clamped',
] as const satisfies readonly ResolveConfidence[];

/**
 * A representation-neutral handle on a top-level block. The ordinal is the
 * primary key (blocks line up 1:1 across representations while the count
 * tripwire holds); `kind` and `content` let a resolve verify it landed on the
 * same thing and downgrade honestly when it did not.
 */
export interface BlockAnchor {
  /** 0-based index of the top-level block in the representation it was captured from. */
  blockIndex: number;
  /** Canonical block kind (see `canonicalBlockKind`). */
  kind: string;
  /** Block text content (markdown syntax stripped). */
  content: string;
  /**
   * Characters into the block from its start, in the capturing representation's
   * terms, for an explicit jump. Absent for a plain toggle, which is scroll-only.
   */
  selectionInBlock?: number;
}

/**
 * A resolved landing in the target coordinate space — full `Y.Text` char offsets
 * for a source landing, ProseMirror positions for a WYSIWYG landing.
 */
export interface ResolvedPosition {
  /** Start of the landed block. */
  blockStart: number;
  /** End of the landed block. */
  blockEnd: number;
  /** Landing point: the block start unless an `exact` grade refined it inline. */
  point: number;
  confidence: ResolveConfidence;
}

/**
 * The live document in both representations. The count tripwire is inherently
 * cross-representation, so every resolve needs both halves even though it only
 * lands in one. `source` is the full `Y.Text('source')` string including the
 * frontmatter region; `doc` is a read-only ProseMirror doc snapshot.
 */
export interface DocSnapshot {
  source: string;
  doc: PmNode;
}

/** Whether a capture should record an inline selection offset (jumps only). */
export interface CaptureOptions {
  refine?: boolean;
}

/**
 * Turns a block anchor captured in one representation into a graded position in
 * the other. `null` from a capture or resolve means "no anchor" — the caller
 * does nothing, reproducing the pre-feature behavior of leaving scroll where it
 * is. All source offsets crossing this boundary are full `Y.Text` offsets with
 * the frontmatter region included; PM positions cross as ProseMirror positions.
 */
export interface ModeSwitchPositionResolver {
  captureFromWysiwyg(doc: PmNode, pos: number, opts?: CaptureOptions): BlockAnchor | null;
  captureFromSource(source: string, fullOffset: number, opts?: CaptureOptions): BlockAnchor | null;
  resolveInSource(anchor: BlockAnchor, snapshot: DocSnapshot): ResolvedPosition | null;
  resolveInWysiwyg(anchor: BlockAnchor, snapshot: DocSnapshot): ResolvedPosition | null;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(value, hi));
}

/**
 * Whitespace-normalized text equality. Soft breaks and blank-line runs serialize
 * differently across the two representations, so a run-collapsing compare keeps
 * genuinely-identical blocks matching; erring toward a match only ever enables an
 * approximate inline refinement, never a wrong-block landing.
 */
function contentEquals(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  return norm(a) === norm(b);
}

/**
 * The grade ladder. A count mismatch (the mandatory tripwire) or an
 * out-of-range ordinal caps the grade below `exact` so a structurally
 * untrustworthy ordinal never claims inline precision.
 */
function gradeFor(
  anchor: BlockAnchor,
  target: { inRange: boolean; tripwireOk: boolean; kind: string; text: string },
): ResolveConfidence {
  if (!target.inRange) return 'clamped';
  if (!target.tripwireOk) return 'ordinal';
  if (contentEquals(anchor.content, target.text)) return 'exact';
  if (anchor.kind === target.kind) return 'same-type-ordinal';
  return 'ordinal';
}

/** The per-source derivations three of the four methods below need. */
interface SourceIndex {
  blocks: SourceBlock[];
  lineStarts: number[];
}

/**
 * The default approximate resolver: ordinal capture, one positioned parse of the
 * live source at resolve time, content-equality verification, and a clamp as the
 * last resort. Small and side-effect-free by design so a byte-accurate
 * implementation can replace it behind the interface.
 */
export function createApproxResolver(md: MarkdownManager): ModeSwitchPositionResolver {
  // One mode switch calls three of the four methods below on the SAME source
  // string inside a single synchronous frame — capture, resolve, then a pin
  // re-anchor — so parsing per call means three or four full mdast parses over
  // identical bytes before the landing gets its first dispatch, all of it on the
  // main thread and all of it inside the window the settle contract exists to
  // keep short. Memoizing on the string itself keeps the derivation a pure
  // function of the snapshot: a single entry suffices because the calls are
  // consecutive, and any edit or later toggle changes the key, which both
  // invalidates the entry and releases the string it held.
  let indexedSource: string | null = null;
  let index: SourceIndex | null = null;

  function indexOf(source: string): SourceIndex {
    if (index !== null && indexedSource === source) return index;
    index = {
      blocks: computeSourceBlocks(source, md).blocks,
      lineStarts: lineStartOffsets(source),
    };
    indexedSource = source;
    return index;
  }

  return {
    captureFromWysiwyg(doc, pos, opts) {
      if (doc.childCount === 0) return null;
      const p = clamp(pos, 0, doc.content.size);
      let acc = 0;
      let blockIndex = doc.childCount - 1;
      let blockContentStart = 0;
      for (let i = 0; i < doc.childCount; i++) {
        const size = doc.child(i).nodeSize;
        if (p < acc + size) {
          blockIndex = i;
          blockContentStart = acc + 1;
          break;
        }
        acc += size;
        blockContentStart = acc + 1;
      }
      const node = doc.child(blockIndex);
      const anchor: BlockAnchor = {
        blockIndex,
        kind: canonicalBlockKind(node.type.name),
        content: node.textContent,
      };
      if (opts?.refine) anchor.selectionInBlock = Math.max(0, p - blockContentStart);
      return anchor;
    },

    captureFromSource(source, fullOffset, opts) {
      const { blocks, lineStarts: offsets } = indexOf(source);
      if (blocks.length === 0) return null;
      const offset = clamp(fullOffset, 0, source.length);
      const line = offsetToLine(offsets, offset);
      // Shared block-offset-table search: a frontmatter-region line maps to the
      // first body block (there is no block above it), so a viewport parked in
      // the FM region lands at the top of the body rather than a false match.
      const blockIndex = blockIndexForLine(blocks, line);
      if (blockIndex === null) return null;
      const block = blocks[blockIndex];
      if (!block) return null;
      const anchor: BlockAnchor = {
        blockIndex,
        kind: block.kind,
        content: block.text,
      };
      if (opts?.refine) {
        const blockStart = lineToOffset(offsets, block.start, source.length);
        anchor.selectionInBlock = Math.max(0, offset - blockStart);
      }
      return anchor;
    },

    resolveInSource(anchor, { source, doc }) {
      const { blocks, lineStarts: offsets } = indexOf(source);
      if (blocks.length === 0) return null;
      const inRange = anchor.blockIndex >= 0 && anchor.blockIndex < blocks.length;
      const tripwireOk = comparableChildCount(doc) === blocks.length;
      const idx = clamp(anchor.blockIndex, 0, blocks.length - 1);
      const block = blocks[idx];
      const blockStart = lineToOffset(offsets, block.start, source.length);
      const blockEnd = Math.min(lineToOffset(offsets, block.end + 1, source.length), source.length);
      const confidence = gradeFor(anchor, {
        inRange,
        tripwireOk,
        kind: block.kind,
        text: block.text,
      });
      let point = blockStart;
      if (confidence === 'exact' && anchor.selectionInBlock !== undefined) {
        point = clamp(blockStart + anchor.selectionInBlock, blockStart, blockEnd);
      }
      return { blockStart, blockEnd, point, confidence };
    },

    resolveInWysiwyg(anchor, { source, doc }) {
      const count = comparableChildCount(doc);
      if (count === 0) return null;
      const { blocks } = indexOf(source);
      const inRange = anchor.blockIndex >= 0 && anchor.blockIndex < count;
      const tripwireOk = count === blocks.length;
      const idx = clamp(anchor.blockIndex, 0, count - 1);
      const range = blockRangeToPositions(doc, idx, idx + 1);
      if (range === null) return null;
      const node = doc.child(idx);
      const confidence = gradeFor(anchor, {
        inRange,
        tripwireOk,
        kind: canonicalBlockKind(node.type.name),
        text: node.textContent,
      });
      return { blockStart: range.from, blockEnd: range.to, point: range.from, confidence };
    },
  };
}
