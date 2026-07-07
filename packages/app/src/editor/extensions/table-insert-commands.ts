/**
 * Pure transaction builders for the Notion-style table edge-insert affordance
 * (`table-insert-controls.ts`). Kept view-free and selection-free so they're
 * unit-testable against a bare `EditorState` — the controls extension owns the
 * DOM/positioning glue, this module owns the document mutation.
 *
 * Both builders APPEND at the far edge (new last column / new last row) rather
 * than relative to a selection: the edge bars are a "grow the table" gesture,
 * not a "insert next to the cursor" one. `addColumn` / `addRow` insert at an
 * explicit index, so `map.width` / `map.height` (one past the last) is the
 * append position — no `CellSelection` round-trip required.
 *
 * OK tables originate from GFM markdown, which is strictly rectangular (no
 * colspan/rowspan), so `TableMap` width/height fully describe the grid.
 */

import type { EditorState, Transaction } from '@tiptap/pm/state';
import { addColumn, addRow, findTable, TableMap } from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';

function tableRectAt(state: EditorState, tablePos: number) {
  const table = state.doc.nodeAt(tablePos);
  if (!table || table.type.name !== 'table') return null;
  const map = TableMap.get(table);
  // `addColumn`/`addRow` only read `map`, `tableStart`, and `table`; the
  // `left/right/top/bottom` cell-range bounds are part of `TableRect` but
  // unused here, so the whole-grid extent is a harmless fill.
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

/** Transaction that appends an empty column to the right of the last column. */
export function appendTableColumn(state: EditorState, tablePos: number): Transaction | null {
  const rect = tableRectAt(state, tablePos);
  if (!rect) return null;
  // `map.width` is one past the rightmost column index → append at the end.
  return addColumn(state.tr, rect, rect.map.width);
}

/** Transaction that appends an empty row below the last row. */
export function appendTableRow(state: EditorState, tablePos: number): Transaction | null {
  const rect = tableRectAt(state, tablePos);
  if (!rect) return null;
  // `map.height` is one past the bottom row index → append at the end.
  return addRow(state.tr, rect, rect.map.height);
}

/**
 * Resolve the document position of the `table` node that owns a rendered DOM
 * element (the `<table>` PM contentDOM, or any node within it). Returns `null`
 * when the element is detached or no longer maps to a table — remote CRDT /
 * agent edits between hover and click can move or delete the table, so callers
 * must treat `null` as "bail, the affordance is stale" (mirrors the stale-pos
 * guarding in `drag-handle.ts`).
 */
export function findTablePosFromDom(view: EditorView, tableDom: HTMLElement): number | null {
  if (!view.dom.contains(tableDom)) return null;
  let pos: number;
  try {
    pos = view.posAtDOM(tableDom, 0);
  } catch {
    return null;
  }
  if (pos < 0) return null;
  // `findTable` walks the ancestor chain for the enclosing table — its `.pos`
  // is `$pos.before(depth)`, exactly the table node position the append
  // builders expect. Same helper prosemirror-tables uses internally.
  return findTable(view.state.doc.resolve(pos))?.pos ?? null;
}
