import { Extension } from '@tiptap/core';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { TextSelection } from '@tiptap/pm/state';
import { addRow, cellAround, TableMap } from '@tiptap/pm/tables';

export function tableEnterDown(state: EditorState): Transaction | null {
  const { selection } = state;
  if (!(selection instanceof TextSelection)) return null;
  const $cell = cellAround(selection.$from);
  if (!$cell) return null;

  const table = $cell.node(-1);
  const tableStart = $cell.start(-1);
  const map = TableMap.get(table);
  const rect = map.findCell($cell.pos - tableStart);

  if (rect.bottom === map.height) {
    const tr = addRow(
      state.tr,
      { map, tableStart, table, left: 0, top: 0, right: map.width, bottom: map.height },
      map.height,
    );
    const tableAfter = tr.doc.nodeAt(tableStart - 1);
    if (!tableAfter) return null;
    const mapAfter = TableMap.get(tableAfter);
    const newCellPos = tableStart + mapAfter.positionAt(map.height, rect.left, tableAfter);
    tr.setSelection(TextSelection.near(tr.doc.resolve(newCellPos + 1)));
    return tr.scrollIntoView();
  }

  const belowOffset = map.positionAt(rect.bottom, rect.left, table);
  const belowCell = table.nodeAt(belowOffset);
  if (!belowCell) return null;
  const belowPos = tableStart + belowOffset;
  const tr = state.tr;
  tr.setSelection(TextSelection.near(tr.doc.resolve(belowPos + belowCell.nodeSize - 1), -1));
  return tr.scrollIntoView();
}

export const TableRowEnter = Extension.create({
  name: 'tableRowEnter',

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const tr = tableEnterDown(editor.state);
        if (!tr) return false;
        editor.view.dispatch(tr);
        return true;
      },
    };
  },
});
