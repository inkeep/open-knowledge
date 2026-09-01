import { sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { describe, expect, test } from 'vitest';

import { computeDragTarget, tableWithMovedColumn, tableWithMovedRow } from './useTableDragReorder';

const schema = getSchema(sharedExtensions);

function cell(text: string, header = false): PmNode {
  const type = header ? schema.nodes.tableHeader : schema.nodes.tableCell;
  return type.createChecked(null, schema.nodes.paragraph.create(null, schema.text(text)));
}

function row(cells: PmNode[]): PmNode {
  return schema.nodes.tableRow.createChecked(null, cells);
}

function makeTable(labels: string[][]): PmNode {
  return schema.nodes.table.createChecked(
    null,
    labels.map((r, i) => row(r.map((label) => cell(label, i === 0)))),
  );
}

function tableTexts(table: PmNode): string[][] {
  const rows: string[][] = [];
  table.forEach((r) => {
    const cells: string[] = [];
    r.forEach((c) => {
      cells.push(c.textContent);
    });
    rows.push(cells);
  });
  return rows;
}

function tableCellKinds(table: PmNode): string[][] {
  const rows: string[][] = [];
  table.forEach((r) => {
    const kinds: string[] = [];
    r.forEach((c) => {
      kinds.push(c.type.name === 'tableHeader' ? 'H' : 'C');
    });
    rows.push(kinds);
  });
  return rows;
}

describe('tableWithMovedRow', () => {
  const t = makeTable([
    ['H1', 'H2'],
    ['A1', 'A2'],
    ['B1', 'B2'],
    ['C1', 'C2'],
  ]);

  test('move down: from=1 to=3 → A lands between B and C (dest = to − 1)', () => {
    const result = tableWithMovedRow(t, 1, 3);
    expect(tableTexts(result)).toEqual([
      ['H1', 'H2'],
      ['B1', 'B2'],
      ['A1', 'A2'],
      ['C1', 'C2'],
    ]);
  });

  test('move down to end: from=1 to=4 → A ends up last', () => {
    const result = tableWithMovedRow(t, 1, 4);
    expect(tableTexts(result)).toEqual([
      ['H1', 'H2'],
      ['B1', 'B2'],
      ['C1', 'C2'],
      ['A1', 'A2'],
    ]);
  });

  test('move up: from=3 to=1 → C lands between H and A (dest = to)', () => {
    const result = tableWithMovedRow(t, 3, 1);
    expect(tableTexts(result)).toEqual([
      ['H1', 'H2'],
      ['C1', 'C2'],
      ['A1', 'A2'],
      ['B1', 'B2'],
    ]);
  });

  test('cell node types travel with their row (movement preserves them)', () => {
    const result = tableWithMovedRow(t, 1, 3);
    expect(tableCellKinds(result)).toEqual([
      ['H', 'H'],
      ['C', 'C'],
      ['C', 'C'],
      ['C', 'C'],
    ]);
  });

  test('table attrs and cell content preserved on move', () => {
    const result = tableWithMovedRow(t, 1, 3);
    expect(result.type.name).toBe('table');
    expect(result.childCount).toBe(4);
  });
});

describe('tableWithMovedColumn', () => {
  const t = makeTable([
    ['H1', 'H2', 'H3'],
    ['A1', 'A2', 'A3'],
    ['B1', 'B2', 'B3'],
  ]);

  test('move down: from=0 to=2 → col 0 lands between col 1 and col 2', () => {
    const result = tableWithMovedColumn(t, 0, 2);
    expect(tableTexts(result)).toEqual([
      ['H2', 'H1', 'H3'],
      ['A2', 'A1', 'A3'],
      ['B2', 'B1', 'B3'],
    ]);
  });

  test('move to end: from=0 to=3 → col 0 ends up last', () => {
    const result = tableWithMovedColumn(t, 0, 3);
    expect(tableTexts(result)).toEqual([
      ['H2', 'H3', 'H1'],
      ['A2', 'A3', 'A1'],
      ['B2', 'B3', 'B1'],
    ]);
  });

  test('move left: from=2 to=0 → col 2 lands at position 0', () => {
    const result = tableWithMovedColumn(t, 2, 0);
    expect(tableTexts(result)).toEqual([
      ['H3', 'H1', 'H2'],
      ['A3', 'A1', 'A2'],
      ['B3', 'B1', 'B2'],
    ]);
  });

  test('each row rebuilt with row attrs preserved', () => {
    const result = tableWithMovedColumn(t, 0, 2);
    expect(result.childCount).toBe(3);
    result.forEach((r) => {
      expect(r.type.name).toBe('tableRow');
      expect(r.childCount).toBe(3);
    });
  });
});

describe('computeDragTarget — pointer → insertion index mapping', () => {
  interface Rect {
    top: number;
    right: number;
    bottom: number;
    left: number;
    width: number;
    height: number;
  }

  function rectOf(left: number, top: number, right: number, bottom: number): Rect {
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  function fakeRow(rect: Rect, cellRects: Rect[]): HTMLTableRowElement {
    return {
      getBoundingClientRect: () => rect as DOMRect,
      cells: cellRects.map((r) => ({
        getBoundingClientRect: () => r as DOMRect,
      })) as unknown as HTMLCollectionOf<HTMLTableCellElement>,
    } as unknown as HTMLTableRowElement;
  }

  function fakeTable(tableRect: Rect, rows: HTMLTableRowElement[]): HTMLTableElement {
    return {
      getBoundingClientRect: () => tableRect as DOMRect,
      rows: rows as unknown as HTMLCollectionOf<HTMLTableRowElement>,
    } as unknown as HTMLTableElement;
  }

  function fakeAnchor(table: HTMLTableElement): HTMLTableCellElement {
    return {
      closest: (sel: string) => (sel === 'table' ? table : null),
    } as unknown as HTMLTableCellElement;
  }

  function threeRowTable() {
    const tableRect = rectOf(0, 0, 200, 60);
    const rows = [
      fakeRow(rectOf(0, 0, 200, 20), [rectOf(0, 0, 100, 20), rectOf(100, 0, 200, 20)]),
      fakeRow(rectOf(0, 20, 200, 40), [rectOf(0, 20, 100, 40), rectOf(100, 20, 200, 40)]),
      fakeRow(rectOf(0, 40, 200, 60), [rectOf(0, 40, 100, 60), rectOf(100, 40, 200, 60)]),
    ];
    const table = fakeTable(tableRect, rows);
    return fakeAnchor(table);
  }

  test('row axis: pointer above the header clamps to insertion index 1', () => {
    const anchor = threeRowTable();
    const result = computeDragTarget(anchor, 'row', 100, -5);
    expect(result?.index).toBe(1);
    expect(result?.rect.top).toBe(20 - 1);
  });

  test('row axis: pointer in header row upper half clamps to index 1', () => {
    const anchor = threeRowTable();
    const result = computeDragTarget(anchor, 'row', 100, 5);
    expect(result?.index).toBe(1);
  });

  test('row axis: pointer in header row lower half → index 1 (unclamped)', () => {
    const anchor = threeRowTable();
    const result = computeDragTarget(anchor, 'row', 100, 15);
    expect(result?.index).toBe(1);
  });

  test('row axis: pointer in row 1 lower half → index 2 (between row 1 and 2)', () => {
    const anchor = threeRowTable();
    const result = computeDragTarget(anchor, 'row', 100, 35);
    expect(result?.index).toBe(2);
    expect(result?.rect.top).toBe(40 - 1);
  });

  test('row axis: pointer below the last row → index = rowCount', () => {
    const anchor = threeRowTable();
    const result = computeDragTarget(anchor, 'row', 100, 100);
    expect(result?.index).toBe(3);
    expect(result?.rect.top).toBe(60 - 1);
  });

  test('column axis: pointer left of column 0 → index 0 (no clamp — columns have no header invariant)', () => {
    const anchor = threeRowTable();
    const result = computeDragTarget(anchor, 'column', -10, 30);
    expect(result?.index).toBe(0);
  });

  test('column axis: pointer in column 0 right half → index 1', () => {
    const anchor = threeRowTable();
    const result = computeDragTarget(anchor, 'column', 60, 30);
    expect(result?.index).toBe(1);
    expect(result?.rect.left).toBe(100 - 1);
  });

  test('column axis: pointer beyond the last column → index = colCount', () => {
    const anchor = threeRowTable();
    const result = computeDragTarget(anchor, 'column', 300, 30);
    expect(result?.index).toBe(2);
  });

  test('anchor with no containing table → null', () => {
    const anchor = { closest: () => null } as unknown as HTMLTableCellElement;
    expect(computeDragTarget(anchor, 'row', 0, 0)).toBeNull();
  });
});
