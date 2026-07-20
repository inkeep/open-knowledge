/**
 * Block-level alignment for the rendered diff. Whole-document word-level diffing
 * matches individual shared words across reordered/rewritten blocks, producing
 * unreadable interleaved word-salad. This aligns the two docs at the BLOCK level
 * instead — unchanged blocks match exactly and vanish; a changed/added/removed
 * block renders as a whole struck "before" + whole highlighted "after". Legible,
 * and consistent with how the Source unified diff reads.
 *
 * Granularity: top-level document blocks, descending one level into lists so a
 * single edited list item is one block (not the whole list). A block is keyed by
 * `type.name` + its text, so an unchanged bullet matches and a reworded one does
 * not. Formatting-only changes (bold/link toggles, no text change) are handled
 * separately by the mark-change pass — they intentionally match here as "same".
 */
import type { Node as PMNode } from '@tiptap/pm/model';

/** A content change as a before-range (`A`) and after-range (`B`). */
export interface SpanChange {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
}

interface Block {
  /** Position before the node in its document. */
  from: number;
  /** Position after the node in its document. */
  to: number;
  /** Alignment key — matches an unchanged block, distinguishes a changed one. */
  key: string;
}

// This schema uses the mdast-canonical unified `list` node (not `bulletList`/
// `orderedList`); the others are kept as a safety net for schema variants.
const LIST_TYPES = new Set(['list', 'bulletList', 'orderedList', 'taskList']);

/**
 * Flatten a doc into aligned block units: top-level children, but the items of a
 * top-level list rather than the list as a whole (so one edited item is one unit).
 */
function collectBlocks(doc: PMNode): Block[] {
  const blocks: Block[] = [];
  doc.forEach((node, offset) => {
    if (LIST_TYPES.has(node.type.name)) {
      const listContentStart = offset + 1;
      let itemOffset = 0;
      node.forEach((item) => {
        const from = listContentStart + itemOffset;
        blocks.push({
          from,
          to: from + item.nodeSize,
          key: `${item.type.name}:${item.textContent}`,
        });
        itemOffset += item.nodeSize;
      });
    } else {
      blocks.push({
        from: offset,
        to: offset + node.nodeSize,
        key: `${node.type.name}:${node.textContent}`,
      });
    }
  });
  return blocks;
}

type AlignOp = { type: 'same'; b: Block } | { type: 'del'; a: Block } | { type: 'ins'; b: Block };

/**
 * Longest-common-subsequence alignment of two block lists by key. Ties favor a
 * deletion first, so a reworded block emits its old form (struck) before its new
 * form (highlighted), reading "~~old~~ new" like a text replacement.
 */
function alignBlocks(before: Block[], after: Block[]): AlignOp[] {
  const n = before.length;
  const m = after.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        before[i].key === after[j].key
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: AlignOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i].key === after[j].key) {
      ops.push({ type: 'same', b: after[j] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', a: before[i] });
      i++;
    } else {
      ops.push({ type: 'ins', b: after[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: 'del', a: before[i++] });
  while (j < m) ops.push({ type: 'ins', b: after[j++] });
  return ops;
}

/**
 * Block-level content changes between two docs. Each deleted block becomes a
 * zero-width-in-B change carrying its before-range (rendered as a struck widget
 * anchored where it used to be); each inserted block a zero-width-in-A change
 * carrying its after-range (highlighted in place). Unchanged blocks produce
 * nothing. `afterDoc` should be the exact doc that will be rendered so the
 * after-coordinates line up with the decoration set.
 */
export function buildBlockChanges(beforeDoc: PMNode, afterDoc: PMNode): SpanChange[] {
  const ops = alignBlocks(collectBlocks(beforeDoc), collectBlocks(afterDoc));
  const changes: SpanChange[] = [];
  // After-doc cursor: a deletion anchors here — just before the following
  // inserted/unchanged content, so a reworded block reads old-then-new.
  let bCursor = 0;
  for (const op of ops) {
    if (op.type === 'same') {
      bCursor = op.b.to;
    } else if (op.type === 'ins') {
      changes.push({ fromA: 0, toA: 0, fromB: op.b.from, toB: op.b.to });
      bCursor = op.b.to;
    } else {
      changes.push({ fromA: op.a.from, toA: op.a.to, fromB: bCursor, toB: bCursor });
    }
  }
  return changes;
}
