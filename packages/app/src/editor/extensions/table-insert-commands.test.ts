import { describe, expect, test } from 'bun:test';
import { sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { TableMap } from '@tiptap/pm/tables';
import { appendTableColumn, appendTableRow } from './table-insert-commands';

// Build the schema from core's shared extensions (an app dependency) rather
// than importing `@tiptap/extension-*` directly — those aren't direct deps of
// this package, only transitive via core, so importing them trips knip.
const schema = getSchema(sharedExtensions);

/** Build a `rows × cols` table doc; row 0 is header cells, the rest body cells. */
function makeTableState(rows: number, cols: number): EditorState {
  const cell = (headerRow: boolean) =>
    (headerRow ? schema.nodes.tableHeader : schema.nodes.tableCell).createChecked(
      null,
      schema.nodes.paragraph.create(),
    );
  const tableRows: PmNode[] = [];
  for (let r = 0; r < rows; r++) {
    const cells: PmNode[] = [];
    for (let c = 0; c < cols; c++) cells.push(cell(r === 0));
    tableRows.push(schema.nodes.tableRow.createChecked(null, cells));
  }
  const table = schema.nodes.table.createChecked(null, tableRows);
  return EditorState.create({ schema, doc: schema.nodes.doc.create(null, table) });
}

function mapAt(state: EditorState, tablePos: number): TableMap {
  const table = state.doc.nodeAt(tablePos);
  if (!table) throw new Error('no table at pos');
  return TableMap.get(table);
}

describe('table-insert-commands', () => {
  test('appendTableColumn grows the table by one column at the right edge', () => {
    const state = makeTableState(2, 2);
    expect(mapAt(state, 0).width).toBe(2);

    const tr = appendTableColumn(state, 0);
    expect(tr).not.toBeNull();
    const next = state.apply(tr as NonNullable<typeof tr>);

    const map = mapAt(next, 0);
    expect(map.width).toBe(3);
    expect(map.height).toBe(2); // rows unchanged
  });

  test('appendTableRow grows the table by one row at the bottom edge', () => {
    const state = makeTableState(2, 3);
    expect(mapAt(state, 0).height).toBe(2);

    const tr = appendTableRow(state, 0);
    expect(tr).not.toBeNull();
    const next = state.apply(tr as NonNullable<typeof tr>);

    const map = mapAt(next, 0);
    expect(map.height).toBe(3);
    expect(map.width).toBe(3); // columns unchanged
  });

  test('returns null when the position is not a table', () => {
    const state = EditorState.create({
      schema,
      doc: schema.nodes.doc.create(null, schema.nodes.paragraph.create()),
    });
    expect(appendTableColumn(state, 0)).toBeNull();
    expect(appendTableRow(state, 0)).toBeNull();
  });
});
