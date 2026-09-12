import type { Transaction } from '@tiptap/pm/state';

export function listItemIntersectsSelection(
  selection: { from: number; to: number },
  itemPos: number,
  itemSize: number,
): boolean {
  return selection.from < itemPos + itemSize - 1 && selection.to > itemPos + 1;
}

export function normalizeList(tr: Transaction, pos: number): void {
  const list = tr.doc.nodeAt(pos);
  if (list?.type.name !== 'list' || !list.attrs.ordered) return;
  list.forEach((item, offset, index) => {
    const ordinal = Number(list.attrs.start) + index;
    if (item.attrs.sourceOrdinal !== ordinal) {
      tr.setNodeMarkup(pos + 1 + offset, undefined, { ...item.attrs, sourceOrdinal: ordinal });
    }
  });
}
