import { sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { CellSelection, TableMap } from '@tiptap/pm/tables';
import { describe, expect, test } from 'vitest';
import { buildAxisSelection, handleAnchorCellPos } from './table-axis-selection';

const schema = getSchema(sharedExtensions);

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

function posInsideCell(doc: PmNode, row: number, col: number): number {
  const table = doc.nodeAt(0);
  if (!table) throw new Error('no table at pos 0');
  return 1 + TableMap.get(table).positionAt(row, col, table) + 1;
}

function cellNodePos(doc: PmNode, row: number, col: number): number {
  return posInsideCell(doc, row, col) - 1;
}

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
    expect(() => buildAxisSelection(doc, 10_000, 'column')).not.toThrow();
    expect(buildAxisSelection(doc, 10_000, 'column')).toBeNull();
  });
});

describe('handleAnchorCellPos', () => {
  const doc = makeTableDoc(3, 3);
  const label = (pos: number | null): string | null =>
    pos === null ? null : (doc.nodeAt(pos)?.textContent ?? null);

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
    expect(fromCellLabel(selection)).toBe('R1C2');
    expect(label(handleAnchorCellPos(selection))).toBe('R1C0');
  });

  test('a selected column anchors on its top cell, not the bottom row', () => {
    const selection = buildAxisSelection(doc, posInsideCell(doc, 0, 2), 'column') as CellSelection;
    expect(fromCellLabel(selection)).toBe('R2C2');
    expect(label(handleAnchorCellPos(selection))).toBe('R0C2');
  });

  test('the clicked handle keeps its own axis', () => {
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
