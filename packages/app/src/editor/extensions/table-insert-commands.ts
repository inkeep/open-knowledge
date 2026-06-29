
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { addColumn, addRow, findTable, TableMap } from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';

function tableRectAt(state: EditorState, tablePos: number) {
  const table = state.doc.nodeAt(tablePos);
  if (!table || table.type.name !== 'table') return null;
  const map = TableMap.get(table);
  return {
    map,
    tableStart: tablePos + 1,
    table,
    left: 0,
    top: 0,
    right: map.width,
    bottom: map.height,
  };
}

export function appendTableColumn(state: EditorState, tablePos: number): Transaction | null {
  const rect = tableRectAt(state, tablePos);
  if (!rect) return null;
  return addColumn(state.tr, rect, rect.map.width);
}

export function appendTableRow(state: EditorState, tablePos: number): Transaction | null {
  const rect = tableRectAt(state, tablePos);
  if (!rect) return null;
  return addRow(state.tr, rect, rect.map.height);
}

export function findTablePosFromDom(view: EditorView, tableDom: HTMLElement): number | null {
  if (!view.dom.contains(tableDom)) return null;
  let pos: number;
  try {
    pos = view.posAtDOM(tableDom, 0);
  } catch {
    return null;
  }
  if (pos < 0) return null;
  return findTable(view.state.doc.resolve(pos))?.pos ?? null;
}
