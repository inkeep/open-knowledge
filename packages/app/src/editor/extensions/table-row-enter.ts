/**
 * Spreadsheet-style Enter inside tables (the Obsidian/Notion model): Enter
 * always moves the caret to the same column of the row below, creating a new
 * row when the caret is already in the last row. Enter NEVER falls through to
 * the default paragraph split inside a cell — a multi-paragraph cell is
 * unrepresentable in GFM, so the split survives only until server
 * canonicalization restructures it unpredictably. Shift+Enter remains the
 * in-cell line break (the one newline GFM cells can represent).
 *
 * Kept as a selection-driven transaction builder (view-free) so it's
 * unit-testable against a bare `EditorState`, mirroring
 * `table-insert-commands.ts`.
 */

import { Extension } from '@tiptap/core';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { TextSelection } from '@tiptap/pm/state';
import { addRow, cellAround, TableMap } from '@tiptap/pm/tables';

/**
 * Transaction moving the caret one row down (same column), appending a row
 * first when the caret sits in the last row; `null` when the selection's head
 * is not inside a table cell (caller falls through to the default Enter).
 */
export function tableEnterDown(state: EditorState): Transaction | null {
  const { selection } = state;
  // Cover non-empty in-cell selections too: the default Enter would delete
  // them and split the cell, recreating the unrepresentable multi-paragraph
  // shape. CellSelection (whole-cell drag) is not a TextSelection and keeps
  // its default handling.
  if (!(selection instanceof TextSelection)) return null;
  const $cell = cellAround(selection.$from);
  if (!$cell) return null;

  const table = $cell.node(-1);
  const tableStart = $cell.start(-1);
  const map = TableMap.get(table);
  const rect = map.findCell($cell.pos - tableStart);

  // GFM tables are rectangular (no rowspan), so bottom === height exactly
  // identifies the last row — including a header-only table, where Enter in
  // the header grows the first body row.
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

  // Not the last row: navigate to the cell below, same column, caret at the
  // END of its content — that's the continue-typing position when the row
  // already holds text.
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
