/**
 * The span the comment composer captures from a selection.
 *
 * The reported failure: selecting a table row and commenting on it quoted the
 * anchor cell alone (`3`), because `Selection.from`/`.to` report the first
 * range and a `CellSelection` has one range per cell.
 */

import { sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { CellSelection, TableMap } from '@tiptap/pm/tables';
import { describe, expect, test } from 'vitest';
import { selectedSpan } from './selected-span';

// Schema from core's shared extensions rather than `@tiptap/extension-*`
// directly — those are only transitive deps here and importing them trips knip.
const schema = getSchema(sharedExtensions);

/** A `rows × cols` table at pos 0; row 0 is header cells, each cell `R{r}C{c}`. */
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

/** Position of the cell node at (row, col) — what `CellSelection` anchors on. */
function cellPos(doc: PmNode, row: number, col: number): number {
  const table = doc.nodeAt(0);
  if (!table) throw new Error('no table at pos 0');
  return 1 + TableMap.get(table).positionAt(row, col, table);
}

/** What the composer would quote for the current selection. */
function quoteFor(state: EditorState): string {
  const { from, to } = selectedSpan(state.selection);
  return state.doc.textBetween(from, to, '\n').trim();
}

describe('selectedSpan', () => {
  test('a text selection is unchanged', () => {
    const doc = schema.nodes.doc.create(
      null,
      schema.nodes.paragraph.create(null, schema.text('hello world')),
    );
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 1, 6),
    });
    expect(selectedSpan(state.selection)).toEqual({ from: 1, to: 6 });
    expect(quoteFor(state)).toBe('hello');
  });

  test('a selected row quotes every cell, not just the anchor', () => {
    const doc = makeTableDoc(3, 3);
    const $cell = doc.resolve(cellPos(doc, 2, 0));
    const state = EditorState.create({
      schema,
      doc,
      selection: CellSelection.rowSelection($cell),
    });

    // The bug: `selection.from`/`.to` describe ONE cell of the row (which one
    // depends on which end the range list starts from — the point is that two
    // of the three cells are missing either way).
    expect(doc.textBetween(state.selection.from, state.selection.to, '\n').trim()).toMatch(
      /^R2C\d$/,
    );
    expect(quoteFor(state)).toBe('R2C0\nR2C1\nR2C2');
  });

  test('the anchor cell does not have to be the leftmost one', () => {
    const doc = makeTableDoc(3, 3);
    const state = EditorState.create({
      schema,
      doc,
      selection: CellSelection.rowSelection(doc.resolve(cellPos(doc, 1, 2))),
    });
    expect(quoteFor(state)).toBe('R1C0\nR1C1\nR1C2');
  });

  test('a selected column spans the table region it runs through', () => {
    // A column's cells are not adjacent in the markdown source, so the span —
    // and the quote — is the contiguous region from its top cell to its
    // bottom one. That IS locatable in the body; a cells-only quote is not.
    const doc = makeTableDoc(3, 2);
    const state = EditorState.create({
      schema,
      doc,
      selection: CellSelection.colSelection(doc.resolve(cellPos(doc, 0, 0))),
    });
    const quote = quoteFor(state);
    expect(quote.startsWith('R0C0')).toBe(true);
    expect(quote.endsWith('R2C0')).toBe(true);
  });

  test('a whole-table selection spans first cell to last', () => {
    const doc = makeTableDoc(2, 2);
    const state = EditorState.create({
      schema,
      doc,
      selection: CellSelection.create(doc, cellPos(doc, 0, 0), cellPos(doc, 1, 1)),
    });
    expect(quoteFor(state)).toBe('R0C0\nR0C1\nR1C0\nR1C1');
  });
});
