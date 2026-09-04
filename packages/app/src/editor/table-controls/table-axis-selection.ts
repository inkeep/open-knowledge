import type { Node as PmNode } from '@tiptap/pm/model';
import type { Selection } from '@tiptap/pm/state';
import { CellSelection, cellAround, TableMap } from '@tiptap/pm/tables';
import type { Editor } from '@tiptap/react';

export type TableAxis = 'column' | 'row';

export function buildAxisSelection(
  doc: PmNode,
  posInCell: number,
  axis: TableAxis,
): CellSelection | null {
  if (posInCell < 0 || posInCell > doc.content.size) return null;
  const $cell = cellAround(doc.resolve(posInCell));
  if (!$cell) return null;
  return axis === 'row' ? CellSelection.rowSelection($cell) : CellSelection.colSelection($cell);
}

export function handleAnchorCellPos(selection: Selection): number | null {
  if (!(selection instanceof CellSelection)) return null;
  const table = selection.$anchorCell.node(-1);
  if (!table) return null;
  const tableStart = selection.$anchorCell.start(-1);
  const map = TableMap.get(table);
  const rect = map.rectBetween(
    selection.$anchorCell.pos - tableStart,
    selection.$headCell.pos - tableStart,
  );
  const offset = map.map[rect.top * map.width + rect.left];
  return offset === undefined ? null : tableStart + offset;
}

export function selectTableAxis(editor: Editor, anchor: HTMLElement, axis: TableAxis): void {
  const { view, state } = editor;
  let posInCell: number;
  try {
    posInCell = view.posAtDOM(anchor, 0);
  } catch (err) {
    console.warn('[TableCellHandles] posAtDOM failed on handle anchor; axis not selected', err);
    return;
  }
  const selection = buildAxisSelection(state.doc, posInCell, axis);
  if (!selection) return;
  view.dispatch(state.tr.setSelection(selection));
}
