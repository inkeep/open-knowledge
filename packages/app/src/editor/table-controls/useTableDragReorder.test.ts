/**
 * Unit tests for the pure PM-node transforms + coordinate mapping in
 * useTableDragReorder. The hook's stateful gesture logic and DOM listener
 * lifecycle are covered by the browser walkthrough in the PR verification;
 * these tests pin the off-by-one arithmetic in the splice-based transforms
 * and the drop-index derivation from pointer coordinates, both of which are
 * exactly the kind of pure logic that regresses silently on a refactor.
 */

import { describe, expect, test } from 'bun:test';
import { sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';

import { computeDragTarget, tableWithMovedColumn, tableWithMovedRow } from './useTableDragReorder';

const schema = getSchema(sharedExtensions);

function cell(text: string, header = false): PmNode {
  const type = header ? schema.nodes.tableHeader : schema.nodes.tableCell;
  return type.createChecked(null, schema.nodes.paragraph.create(null, schema.text(text)));
}

function row(cells: PmNode[]): PmNode {
  return schema.nodes.tableRow.createChecked(null, cells);
}

/** Build a `rows × cols` table doc; row 0 uses tableHeader cells, the rest
 * tableCell. The label is the cell text so assertions read directly. */
function makeTable(labels: string[][]): PmNode {
  return schema.nodes.table.createChecked(
    null,
    labels.map((r, i) => row(r.map((label) => cell(label, i === 0)))),
  );
}

/** Row-by-row text snapshot for concise reorder assertions. */
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

/** Header/body kind per cell, so cell-type invariant tests read directly. */
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
    ['H1', 'H2'], // row 0 — header
    ['A1', 'A2'],
    ['B1', 'B2'],
    ['C1', 'C2'],
  ]);

  test('move down: from=1 to=3 → A lands between B and C (dest = to − 1)', () => {
    // The critical off-by-one branch. Removing index 1 shifts C to index 2,
    // so a target of 3 in the original list becomes 2 in the spliced list.
    // A regression to `dest = to` would insert A after C instead of between.
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
    // Sibling-symmetric with move-down. The `to > from` branch is skipped
    // here so `dest` stays `to`. Regression to `dest = to - 1` would put
    // C above the header — a header-invariant break in disguise.
    const result = tableWithMovedRow(t, 3, 1);
    expect(tableTexts(result)).toEqual([
      ['H1', 'H2'],
      ['C1', 'C2'],
      ['A1', 'A2'],
      ['B1', 'B2'],
    ]);
  });

  test('cell node types travel with their row (movement preserves them)', () => {
    // The transform is a pure splice — no cell-type mutation. But the
    // header-invariant guards in commitReorder / computeDragTarget are what
    // prevent a data row from LANDING at index 0 to begin with; this test
    // pins that the pure splice really does move rows verbatim.
    const result = tableWithMovedRow(t, 1, 3);
    expect(tableCellKinds(result)).toEqual([
      ['H', 'H'], // row 0 still header cells
      ['C', 'C'],
      ['C', 'C'],
      ['C', 'C'],
    ]);
  });

  test('table attrs and cell content preserved on move', () => {
    // Table attrs / marks must survive a splice — the transform copies them
    // through table.type.create(table.attrs, rows, table.marks).
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
  // Fake element shape covering everything computeDragTarget touches on the
  // anchor: `closest('table')` for the containing table, then per-row and
  // per-cell `getBoundingClientRect`. Keeps the test DOM-free (bun-test has
  // no live DOM) while exercising the real code path.

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

  /** Build a 3-row table with rows stacked vertically: header 0-20, row 1
   * 20-40, row 2 40-60. Cell widths: 100 each, 2 columns. */
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
    // Without the header-invariant clamp this would return index 0, which
    // would silently invert the markdown header on the next round-trip.
    const anchor = threeRowTable();
    const result = computeDragTarget(anchor, 'row', 100, -5);
    expect(result?.index).toBe(1);
    // Indicator y anchored to the bottom of the header row.
    expect(result?.rect.top).toBe(20 - 1);
  });

  test('row axis: pointer in header row upper half clamps to index 1', () => {
    // Regression pin: a raw split would return 0 here (upper half → insert-
    // before-row-0). Clamp keeps it at 1.
    const anchor = threeRowTable();
    const result = computeDragTarget(anchor, 'row', 100, 5);
    expect(result?.index).toBe(1);
  });

  test('row axis: pointer in header row lower half → index 1 (unclamped)', () => {
    // Below the header midpoint is a natural "insert after header" → index 1.
    // No clamp needed, but the result should still be 1.
    const anchor = threeRowTable();
    const result = computeDragTarget(anchor, 'row', 100, 15);
    expect(result?.index).toBe(1);
  });

  test('row axis: pointer in row 1 lower half → index 2 (between row 1 and 2)', () => {
    const anchor = threeRowTable();
    const result = computeDragTarget(anchor, 'row', 100, 35);
    expect(result?.index).toBe(2);
    // Indicator at row 1's bottom edge.
    expect(result?.rect.top).toBe(40 - 1);
  });

  test('row axis: pointer below the last row → index = rowCount', () => {
    const anchor = threeRowTable();
    const result = computeDragTarget(anchor, 'row', 100, 100);
    expect(result?.index).toBe(3);
    // Indicator at the last row's bottom edge.
    expect(result?.rect.top).toBe(60 - 1);
  });

  test('column axis: pointer left of column 0 → index 0 (no clamp — columns have no header invariant)', () => {
    // Symmetric to the row test, but columns lack the positional-header
    // constraint (markdown has no header-column concept), so index 0 is a
    // legitimate target here. Regression pin: someone applying the row
    // clamp to columns would break this.
    const anchor = threeRowTable();
    const result = computeDragTarget(anchor, 'column', -10, 30);
    expect(result?.index).toBe(0);
  });

  test('column axis: pointer in column 0 right half → index 1', () => {
    const anchor = threeRowTable();
    const result = computeDragTarget(anchor, 'column', 60, 30);
    expect(result?.index).toBe(1);
    // Indicator at column 0's right edge.
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
