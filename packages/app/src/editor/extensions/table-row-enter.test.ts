import { sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { CellSelection, cellAround, TableMap } from '@tiptap/pm/tables';
import { describe, expect, test } from 'vitest';
import { tableEnterDown } from './table-row-enter';

const schema = getSchema(sharedExtensions);

function makeTableDoc(rows: number, cols: number, withText = false): PmNode {
  const cell = (r: number, c: number) =>
    (r === 0 ? schema.nodes.tableHeader : schema.nodes.tableCell).createChecked(
      null,
      schema.nodes.paragraph.create(null, withText ? schema.text(`R${r}C${c}`) : undefined),
    );
  const tableRows: PmNode[] = [];
  for (let r = 0; r < rows; r++) {
    const cells: PmNode[] = [];
    for (let c = 0; c < cols; c++) cells.push(cell(r, c));
    tableRows.push(schema.nodes.tableRow.createChecked(null, cells));
  }
  const table = schema.nodes.table.createChecked(null, tableRows);
  return schema.nodes.doc.create(null, table);
}

function stateWithCaretInCell(doc: PmNode, row: number, col: number): EditorState {
  const table = doc.nodeAt(0);
  if (!table) throw new Error('no table at pos 0');
  const tableStart = 1;
  const cellPos = tableStart + TableMap.get(table).positionAt(row, col, table);
  return EditorState.create({
    schema,
    doc,
    selection: TextSelection.near(doc.resolve(cellPos + 1)),
  });
}

function caretCellRect(state: EditorState) {
  const $cell = cellAround(state.selection.$from);
  if (!$cell) throw new Error('caret not in a cell');
  const table = $cell.node(-1);
  return TableMap.get(table).findCell($cell.pos - $cell.start(-1));
}

describe('tableEnterDown', () => {
  test('caret in a last-row cell appends a row and moves the caret to it', () => {
    const state = stateWithCaretInCell(makeTableDoc(3, 3), 2, 1);

    const tr = tableEnterDown(state);
    expect(tr).not.toBeNull();
    const next = state.apply(tr as NonNullable<typeof tr>);

    const table = next.doc.nodeAt(0);
    const map = TableMap.get(table as PmNode);
    expect(map.height).toBe(4);
    expect(map.width).toBe(3);

    const rect = caretCellRect(next);
    expect(rect.top).toBe(3);
    expect(rect.left).toBe(1);

    const lastRow = (table as PmNode).child(3);
    for (let c = 0; c < lastRow.childCount; c++) {
      expect(lastRow.child(c).type.name).toBe('tableCell');
    }
  });

  test('header row of a header-only table counts as the last row', () => {
    const state = stateWithCaretInCell(makeTableDoc(1, 2), 0, 0);

    const tr = tableEnterDown(state);
    expect(tr).not.toBeNull();
    const next = state.apply(tr as NonNullable<typeof tr>);

    expect(TableMap.get(next.doc.nodeAt(0) as PmNode).height).toBe(2);
    const rect = caretCellRect(next);
    expect(rect.top).toBe(1);
    expect(rect.left).toBe(0);
  });

  test('caret in a non-last row navigates to the END of the cell below', () => {
    const state = stateWithCaretInCell(makeTableDoc(3, 3, true), 1, 2);

    const tr = tableEnterDown(state);
    expect(tr).not.toBeNull();
    const next = state.apply(tr as NonNullable<typeof tr>);

    expect(next.doc.eq(state.doc)).toBe(true);
    const rect = caretCellRect(next);
    expect(rect.top).toBe(2);
    expect(rect.left).toBe(2);

    expect(next.selection.empty).toBe(true);
    expect(next.selection.$from.parent.textContent).toBe('R2C2');
    expect(next.selection.$from.parentOffset).toBe('R2C2'.length);
  });

  test('caret in a header cell of a multi-row table navigates to the first body row', () => {
    const state = stateWithCaretInCell(makeTableDoc(3, 2, true), 0, 1);

    const tr = tableEnterDown(state);
    expect(tr).not.toBeNull();
    const next = state.apply(tr as NonNullable<typeof tr>);

    expect(next.doc.eq(state.doc)).toBe(true);
    const rect = caretCellRect(next);
    expect(rect.top).toBe(1);
    expect(rect.left).toBe(1);
    expect(next.selection.$from.parent.textContent).toBe('R1C1');
    expect(next.selection.$from.parentOffset).toBe('R1C1'.length);
  });

  test('a non-empty in-cell selection is intercepted (moves down, no cell split)', () => {
    const doc = makeTableDoc(3, 2);
    const table = doc.nodeAt(0) as PmNode;
    const cellPos = 1 + TableMap.get(table).positionAt(1, 0, table);
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, cellPos + 1, cellPos + 2),
    });

    const tr = tableEnterDown(state);
    expect(tr).not.toBeNull();
    const next = state.apply(tr as NonNullable<typeof tr>);

    expect(next.doc.eq(state.doc)).toBe(true);
    const rect = caretCellRect(next);
    expect(rect.top).toBe(2);
    expect(rect.left).toBe(0);
  });

  test('a CellSelection (whole-cell drag) falls through to default handling', () => {
    const doc = makeTableDoc(3, 2, true);
    const table = doc.nodeAt(0) as PmNode;
    const cellPos = 1 + TableMap.get(table).positionAt(1, 0, table);
    const state = EditorState.create({
      schema,
      doc,
      selection: CellSelection.create(doc, cellPos),
    });
    expect(tableEnterDown(state)).toBeNull();
  });

  test('caret outside any table falls through', () => {
    const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create());
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.near(doc.resolve(1)),
    });
    expect(tableEnterDown(state)).toBeNull();
  });
});
