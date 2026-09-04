import type { Node as PMNode } from '@tiptap/pm/model';

export interface SpanChange {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
}

interface Block {
  from: number;
  to: number;
  key: string;
}

const LIST_TYPES = new Set(['list', 'bulletList', 'orderedList', 'taskList']);

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

export function buildBlockChanges(beforeDoc: PMNode, afterDoc: PMNode): SpanChange[] {
  const ops = alignBlocks(collectBlocks(beforeDoc), collectBlocks(afterDoc));
  const changes: SpanChange[] = [];
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
