/**
 * Row / column selection built from a handle's anchor cell.
 *
 * The handles used to open a menu and nothing else, so no gesture selected a
 * whole row or column — a table could only be picked by sweeping the pointer
 * across its cells. These pin that a handle's cell resolves to a
 * `CellSelection` covering its entire axis, and that a position outside any
 * cell declines instead of throwing.
 */

import { sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { CellSelection, TableMap } from '@tiptap/pm/tables';
import { describe, expect, test } from 'vitest';
import { buildAxisSelection, handleAnchorCellPos } from './table-axis-selection';

// Schema from core's shared extensions rather than `@tiptap/extension-*`
// directly — those are only transitive deps here and importing them trips knip
// (same setup as table-row-enter.test.ts).
const schema = getSchema(sharedExtensions);

/** A `rows × cols` table at pos 0; row 0 is header cells. Each cell holds `R{r}C{c}`. */
function makeTableDoc(rows: number, cols: number): PmNode {
  const cell = (r: number, c: number) =>
    (r === 0 ? schema.nodes.tableHeader : schema.nodes.tableCell).createChecked(
      null,
      schema.nodes.paragraph.create(null, schema.text(`R${r}C${c}`)),
    );
  const tableRows: PmNode[] = [];
  for (let r = 0; r < rows; r++) {
    const cells: PmNode[] = [];
    for (let c = 0; c < cols; c++) cells.push(cell(r, c));
    tableRows.push(schema.nodes.tableRow.createChecked(null, cells));
  }
  return schema.nodes.doc.create(null, schema.nodes.table.createChecked(null, tableRows));
}

/** Position INSIDE the cell at (row, col) — what `posAtDOM(cell, 0)` returns. */
function posInsideCell(doc: PmNode, row: number, col: number): number {
  const table = doc.nodeAt(0);
  if (!table) throw new Error('no table at pos 0');
  return 1 + TableMap.get(table).positionAt(row, col, table) + 1;
}

/** Position OF the cell node at (row, col) — what a CellSelection anchors on. */
function cellNodePos(doc: PmNode, row: number, col: number): number {
  return posInsideCell(doc, row, col) - 1;
}

/**
 * The `R{r}C{c}` label of every cell the selection covers, in document order.
 * `forEachCell` walks the grid row-major; `ranges` would report the anchor
 * cell first, which says nothing about coverage.
 */
function selectedLabels(selection: CellSelection | null): string[] {
  if (!selection) throw new Error('expected a CellSelection');
  const labels: string[] = [];
  selection.forEachCell((cell) => labels.push(cell.textContent));
  return labels;
}

describe('buildAxisSelection', () => {
  const doc = makeTableDoc(3, 3);

  test('a row handle selects every cell in its row', () => {
    const selection = buildAxisSelection(doc, posInsideCell(doc, 1, 0), 'row');
    expect(selection).not.toBeNull();
    expect(selectedLabels(selection)).toEqual(['R1C0', 'R1C1', 'R1C2']);
  });

  test('a column handle selects every cell in its column, header included', () => {
    const selection = buildAxisSelection(doc, posInsideCell(doc, 0, 2), 'column');
    expect(selection).not.toBeNull();
    expect(selectedLabels(selection)).toEqual(['R0C2', 'R1C2', 'R2C2']);
  });

  test('a row selection spans the row it was asked for, not the one above', () => {
    const selection = buildAxisSelection(doc, posInsideCell(doc, 2, 1), 'row');
    expect(selectedLabels(selection)).toEqual(['R2C0', 'R2C1', 'R2C2']);
  });

  test('a header row selects like any other', () => {
    const selection = buildAxisSelection(doc, posInsideCell(doc, 0, 0), 'row');
    expect(selectedLabels(selection)).toEqual(['R0C0', 'R0C1', 'R0C2']);
  });

  test('a position outside any cell declines', () => {
    const outside = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null));
    expect(buildAxisSelection(outside, 1, 'row')).toBeNull();
  });

  test('an out-of-range position declines rather than throwing', () => {
    // The anchor cell is read from live DOM, so a remote edit can shrink the
    // document between the pointer gesture and this call.
    expect(() => buildAxisSelection(doc, 10_000, 'column')).not.toThrow();
    expect(buildAxisSelection(doc, 10_000, 'column')).toBeNull();
  });
});

describe('handleAnchorCellPos', () => {
  const doc = makeTableDoc(3, 3);
  const label = (pos: number | null): string | null =>
    pos === null ? null : (doc.nodeAt(pos)?.textContent ?? null);

  /** The cell `computeActiveCell` used to land on: walk up from `$from`. */
  function fromCellLabel(selection: CellSelection): string | null {
    const $from = selection.$from;
    for (let depth = $from.depth; depth > 0; depth--) {
      const role = $from.node(depth).type.spec.tableRole;
      if (role === 'cell' || role === 'header_cell') return label($from.before(depth));
    }
    return null;
  }

  test('a selected row anchors on its leftmost cell, not the far corner', () => {
    const selection = buildAxisSelection(doc, posInsideCell(doc, 1, 0), 'row') as CellSelection;
    // The regression: `$from` is the axis's FAR end, so the column handle
    // followed it to the last column and lost its header-toggle item.
    expect(fromCellLabel(selection)).toBe('R1C2');
    expect(label(handleAnchorCellPos(selection))).toBe('R1C0');
  });

  test('a selected column anchors on its top cell, not the bottom row', () => {
    const selection = buildAxisSelection(doc, posInsideCell(doc, 0, 2), 'column') as CellSelection;
    expect(fromCellLabel(selection)).toBe('R2C2');
    expect(label(handleAnchorCellPos(selection))).toBe('R0C2');
  });

  test('the clicked handle keeps its own axis', () => {
    // Clicking row 2's handle must leave the row handle on row 2 (column 0),
    // wherever the sibling ends up.
    const selection = buildAxisSelection(doc, posInsideCell(doc, 2, 1), 'row') as CellSelection;
    expect(label(handleAnchorCellPos(selection))).toBe('R2C0');
  });

  test('a dragged cell range anchors on its top-left', () => {
    const selection = CellSelection.create(
      doc,
      cellNodePos(doc, 2, 2),
      cellNodePos(doc, 1, 1),
    ) as CellSelection;
    expect(label(handleAnchorCellPos(selection))).toBe('R1C1');
  });

  test('a plain caret selection defers to the caller', () => {
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.near(doc.resolve(posInsideCell(doc, 1, 1))),
    });
    expect(handleAnchorCellPos(state.selection)).toBeNull();
  });
});
