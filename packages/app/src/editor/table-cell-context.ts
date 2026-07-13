/**
 * Table-cell context — the shared cell-node set and selection predicate for
 * the surfaces that must treat a GFM table cell specially.
 *
 * A GFM cell serializes to a single phrasing-only line, so a block component
 * placed in one is dropped whole on serialize. The cell-insertion gate refuses
 * that placement and the slash menu withholds the affordance; both key off the
 * same cell definition here so they can never diverge (a header cell flattens
 * exactly like a data cell — guarding only `tableCell` would leave a silent gap
 * for `tableHeader`).
 */

import type { EditorState } from '@tiptap/pm/state';

// Both cell kinds serialize to one phrasing-only line, so a block component in
// either is lost on serialize. Treat both as cell context.
export const CELL_NODES: ReadonlySet<string> = new Set(['tableCell', 'tableHeader']);

/**
 * Whether the current selection sits inside a GFM table cell (data or header).
 * Walks the resolved caret's ancestors, so it holds for a collapsed caret or a
 * range fully inside a cell.
 */
export function isSelectionInTableCell(state: EditorState): boolean {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    if (CELL_NODES.has($from.node(depth).type.name)) return true;
  }
  return false;
}
