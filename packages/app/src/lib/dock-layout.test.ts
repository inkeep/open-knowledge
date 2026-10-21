import { describe, expect, test } from 'vitest';
import {
  clampDockSeam,
  type DockExtent,
  type DockRect,
  dockSeamPercent,
  dockSeamShares,
  EMPTY_DOCK_LAYOUT,
  fitDockLengths,
  layoutDock,
  minDockExtent,
} from './dock-layout.ts';
import { DEFAULT_DOCK_TREE, resizeDockGroup, visibleDockTree } from './dock-tree.ts';
import type { PaneId } from './pane-visibility-store.ts';

const MINS: Record<PaneId, DockExtent> = {
  editor: { width: 340, height: 180 },
  agents: { width: 290, height: 170 },
  terminal: { width: 325, height: 120 },
};
const minOf = (pane: PaneId) => MINS[pane];
const GAP = 8;
const BOUNDS: DockRect = { x: 0, y: 0, width: 1200, height: 800 };
const everyPane = () => true;

describe('fitDockLengths', () => {
  test('keeps lengths that already meet their minimums', () => {
    expect(fitDockLengths([600, 400], [100, 100], 1000)).toEqual([600, 400]);
  });

  test('raises an item to its minimum and takes the difference from the others in proportion', () => {
    const lengths = fitDockLengths([900, 50, 50], [100, 200, 0], 1000);
    expect(lengths[1]).toBe(200);
    expect(lengths[0]).toBeCloseTo((900 / 950) * 800);
    expect(lengths[2]).toBeCloseTo((50 / 950) * 800);
    expect(lengths.reduce((sum, length) => sum + length, 0)).toBeCloseTo(1000);
  });

  test('raises an item that raising another pushed under its own minimum', () => {
    const lengths = fitDockLengths([300, 400, 300], [340, 325, 290], 1000);
    expect(lengths[0]).toBe(340);
    expect(lengths[2]).toBe(290);
    expect(lengths[1]).toBeCloseTo(1000 - 340 - 290);
  });

  test('shares the room by minimum when every minimum cannot fit', () => {
    expect(fitDockLengths([500, 500], [300, 100], 200)).toEqual([150, 50]);
  });

  test('gives nothing when there is no room', () => {
    expect(fitDockLengths([0, 0], [0, 0], 0)).toEqual([0, 0]);
  });
});

describe('minDockExtent', () => {
  test('adds minimums along a group and takes the largest across it', () => {
    const tree = visibleDockTree(DEFAULT_DOCK_TREE, everyPane);
    if (tree === null) throw new Error('expected a tree');
    expect(minDockExtent(tree, minOf, GAP)).toEqual({
      width: 340 + GAP + 290,
      height: 180 + GAP + 120,
    });
  });
});

describe('layoutDock', () => {
  test('lays the default tree out edge to edge with a gap between units', () => {
    const layout = layoutDock(visibleDockTree(DEFAULT_DOCK_TREE, everyPane), BOUNDS, GAP, minOf);
    const editor = layout.panes.get('editor');
    const terminal = layout.panes.get('terminal');
    const agents = layout.panes.get('agents');
    if (editor === undefined || terminal === undefined || agents === undefined) {
      throw new Error('expected every pane');
    }
    expect(editor.x).toBe(0);
    expect(editor.y).toBe(0);
    expect(terminal.x).toBe(0);
    expect(terminal.y).toBe(editor.height + GAP);
    expect(terminal.y + terminal.height).toBe(BOUNDS.height);
    expect(agents.x).toBe(editor.width + GAP);
    expect(agents.x + agents.width).toBe(BOUNDS.width);
    expect(agents.height).toBe(BOUNDS.height);
    expect(editor.width / agents.width).toBeCloseTo(2.5, 1);
    expect(editor.height / terminal.height).toBeCloseTo(2.3, 1);
    expect(layout.seams).toHaveLength(2);
  });

  test('puts each seam in the gap between the units it separates', () => {
    const layout = layoutDock(visibleDockTree(DEFAULT_DOCK_TREE, everyPane), BOUNDS, GAP, minOf);
    const editor = layout.panes.get('editor');
    const row = layout.seams.find((seam) => seam.direction === 'row');
    const column = layout.seams.find((seam) => seam.direction === 'column');
    if (editor === undefined || row === undefined || column === undefined) {
      throw new Error('expected both seams');
    }
    expect(row.rect).toEqual({ x: editor.width, y: 0, width: GAP, height: BOUNDS.height });
    expect(row.after).toEqual(['agents']);
    expect(column.rect).toEqual({ x: 0, y: editor.height, width: editor.width, height: GAP });
    expect(column.path).toEqual([0]);
  });

  test('gives a lone pane the whole workspace and no seams', () => {
    const layout = layoutDock(
      visibleDockTree(DEFAULT_DOCK_TREE, (pane) => pane === 'agents'),
      BOUNDS,
      GAP,
      minOf,
    );
    expect(layout.panes.get('agents')).toEqual(BOUNDS);
    expect(layout.seams).toHaveLength(0);
  });

  test('lays out nothing without a tree or without room', () => {
    expect(layoutDock(null, BOUNDS, GAP, minOf)).toBe(EMPTY_DOCK_LAYOUT);
    expect(
      layoutDock(
        visibleDockTree(DEFAULT_DOCK_TREE, everyPane),
        { ...BOUNDS, width: 0 },
        GAP,
        minOf,
      ),
    ).toBe(EMPTY_DOCK_LAYOUT);
  });

  test('keeps each pane at its minimum when the stored share is smaller', () => {
    const squeezed = resizeDockGroup(
      DEFAULT_DOCK_TREE,
      [],
      new Map([
        [0, 0.97],
        [1, 0.03],
      ]),
    );
    const layout = layoutDock(visibleDockTree(squeezed, everyPane), BOUNDS, GAP, minOf);
    expect(layout.panes.get('agents')?.width).toBe(290);
  });
});

describe('dock seams', () => {
  const layout = layoutDock(visibleDockTree(DEFAULT_DOCK_TREE, everyPane), BOUNDS, GAP, minOf);
  const rowSeam = layout.seams.find((seam) => seam.direction === 'row');
  if (rowSeam === undefined) throw new Error('expected a row seam');

  test('a drag past a minimum stops at it', () => {
    expect(clampDockSeam(rowSeam, 10)).toBe(340);
    const pair = (rowSeam.lengths[0] ?? 0) + (rowSeam.lengths[1] ?? 0);
    expect(clampDockSeam(rowSeam, pair)).toBe(pair - 290);
  });

  test('moving a seam keeps the other units and lands where it was dropped', () => {
    const shares = dockSeamShares(rowSeam, 700);
    expect([...shares.values()].reduce((sum, share) => sum + share, 0)).toBeCloseTo(1);
    const resized = resizeDockGroup(DEFAULT_DOCK_TREE, rowSeam.path, shares);
    const after = layoutDock(visibleDockTree(resized, everyPane), BOUNDS, GAP, minOf);
    expect(after.panes.get('editor')?.width).toBe(700);
    expect(after.panes.get('agents')?.width).toBe(BOUNDS.width - 700 - GAP);
  });

  test('reports the share of the pane after it as a percentage within its limits', () => {
    const value = dockSeamPercent(rowSeam);
    const pair = (rowSeam.lengths[0] ?? 0) + (rowSeam.lengths[1] ?? 0);
    expect(value.now).toBe(Math.round(((rowSeam.lengths[1] ?? 0) / pair) * 100));
    expect(value.min).toBeLessThanOrEqual(value.now);
    expect(value.now).toBeLessThanOrEqual(value.max);
    expect(value.max).toBeLessThanOrEqual(100);
    expect(value.min).toBeGreaterThanOrEqual(0);
  });
});
