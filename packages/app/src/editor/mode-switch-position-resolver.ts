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

export type ResolveConfidence = 'exact' | 'same-type-ordinal' | 'ordinal' | 'clamped';

export const CONFIDENCE_ORDER = [
  'exact',
  'same-type-ordinal',
  'ordinal',
  'clamped',
] as const satisfies readonly ResolveConfidence[];

export interface BlockAnchor {
  blockIndex: number;
  kind: string;
  content: string;
  selectionInBlock?: number;
}

export interface ResolvedPosition {
  blockStart: number;
  blockEnd: number;
  point: number;
  confidence: ResolveConfidence;
}

export interface DocSnapshot {
  source: string;
  doc: PmNode;
}

export interface CaptureOptions {
  refine?: boolean;
}

export interface ModeSwitchPositionResolver {
  captureFromWysiwyg(doc: PmNode, pos: number, opts?: CaptureOptions): BlockAnchor | null;
  captureFromSource(source: string, fullOffset: number, opts?: CaptureOptions): BlockAnchor | null;
  resolveInSource(anchor: BlockAnchor, snapshot: DocSnapshot): ResolvedPosition | null;
  resolveInWysiwyg(anchor: BlockAnchor, snapshot: DocSnapshot): ResolvedPosition | null;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(value, hi));
}

function contentEquals(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  return norm(a) === norm(b);
}

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

interface SourceIndex {
  blocks: SourceBlock[];
  lineStarts: number[];
}

export function createApproxResolver(md: MarkdownManager): ModeSwitchPositionResolver {
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
