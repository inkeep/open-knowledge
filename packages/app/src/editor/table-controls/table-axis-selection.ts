/**
 * Select a whole table row or column.
 *
 * The row / column handles opened a menu and nothing else, so a table had no
 * "pick this row" gesture at all: dragging across cells was the only way to
 * reach a `CellSelection`, and dragging a column meant sweeping its full
 * height. Clicking a handle now selects the axis it belongs to, which is what
 * makes the row visibly highlighted and hands every selection-scoped surface —
 * copy, delete, the bubble menu's comment entry — a real range to act on.
 *
 * Split from `TableCellHandles` so the position arithmetic is testable without
 * a mounted editor view: `buildAxisSelection` is pure, and only the thin DOM
 * lookup below needs the view.
 */

import type { Node as PmNode } from '@tiptap/pm/model';
import type { Selection } from '@tiptap/pm/state';
import { CellSelection, cellAround, TableMap } from '@tiptap/pm/tables';
import type { Editor } from '@tiptap/react';

export type TableAxis = 'column' | 'row';

/**
 * A `CellSelection` spanning the full row / column through `posInCell`, or null
 * when that position is not inside a table cell.
 *
 * Null rather than throwing: the anchor cell is resolved from live DOM, and a
 * remote edit can detach it between the pointer gesture and this call.
 */
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

/**
 * The cell both handles should anchor to for a table selection, or null when
 * the selection is not one (the caller then walks up from `$from` as before).
 *
 * The selection's TOP-LEFT cell, deliberately. `rowSelection` / `colSelection`
 * normalise their arguments to the two far corners of the axis, and the
 * resulting `$from` is the FAR one — so deriving the handles from `$from` sent
 * the sibling handle to the table's last column (or last row) the moment an
 * axis was selected, flipping its `isFirst*` flag and silently dropping the
 * header-toggle item from its menu. Top-left keeps the clicked handle where it
 * is and puts the sibling at the axis origin.
 */
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

/**
 * Select the row / column that `anchor` belongs to. No-op when the cell cannot
 * be located, so a stale handle never throws into the editor's error boundary.
 */
export function selectTableAxis(editor: Editor, anchor: HTMLElement, axis: TableAxis): void {
  const { view, state } = editor;
  let posInCell: number;
  try {
    // Offset 0 lands inside the cell's first child, which is what `cellAround`
    // needs to walk up from — the cell's own position resolves to its parent
    // row and would find the wrong node.
    posInCell = view.posAtDOM(anchor, 0);
  } catch (err) {
    // posAtDOM throws on detached/partially-recycled DOM. Declining to select
    // is the correct fallback, but log so a systematic failure (e.g. after a
    // ProseMirror upgrade) leaves a signal instead of a handle that silently
    // stops selecting — matching the sibling catch in markdown-lint-decorations.
    console.warn('[TableCellHandles] posAtDOM failed on handle anchor; axis not selected', err);
    return;
  }
  const selection = buildAxisSelection(state.doc, posInCell, axis);
  if (!selection) return;
  view.dispatch(state.tr.setSelection(selection));
}
