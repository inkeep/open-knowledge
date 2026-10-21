import { describe, expect, test } from 'vitest';
import {
  DEFAULT_BOTTOM_TERMINAL_SHARE,
  DEFAULT_DOCK_TREE,
  type DockGroup,
  type DockNode,
  dockPaneDirection,
  dockTreePanes,
  isDockLeaf,
  isVisibleDockLeaf,
  moveDockPane,
  moveDockPaneToEdge,
  normalizeDockTree,
  parseDockTree,
  resizeDockGroup,
  swapDockPanes,
  type VisibleDockGroup,
  visibleDockTree,
} from './dock-tree.ts';
import type { PaneId } from './pane-visibility-store.ts';

function shape(node: DockNode): unknown {
  if (isDockLeaf(node)) return node.pane;
  return { [node.direction]: node.items.map((item) => shape(item.node)) };
}

function sizes(node: DockNode): number[] {
  return isDockLeaf(node) ? [] : node.items.map((item) => Number(item.size.toFixed(4)));
}

function only(...panes: PaneId[]) {
  return (pane: PaneId) => panes.includes(pane);
}

const everyPane = only('editor', 'agents', 'terminal');

describe('parseDockTree', () => {
  test('reads back the default tree', () => {
    const parsed = parseDockTree(JSON.parse(JSON.stringify(DEFAULT_DOCK_TREE)));
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(shape(parsed)).toEqual({ row: [{ column: ['editor', 'terminal'] }, 'agents'] });
    expect(sizes(parsed).reduce((sum, size) => sum + size, 0)).toBeCloseTo(1);
  });

  test.each([
    ['a value that is not a tree', 'editor'],
    ['null', null],
    [
      'an unknown pane',
      {
        direction: 'row',
        items: [
          { size: 1, node: { pane: 'graph' } },
          { size: 1, node: { pane: 'editor' } },
        ],
      },
    ],
    [
      'a pane listed twice',
      {
        direction: 'row',
        items: [
          { size: 1, node: { pane: 'editor' } },
          { size: 1, node: { pane: 'editor' } },
          { size: 1, node: { pane: 'agents' } },
        ],
      },
    ],
    [
      'a missing pane',
      {
        direction: 'row',
        items: [
          { size: 1, node: { pane: 'editor' } },
          { size: 1, node: { pane: 'agents' } },
        ],
      },
    ],
    [
      'an unknown direction',
      {
        direction: 'diagonal',
        items: [
          { size: 1, node: { pane: 'editor' } },
          { size: 1, node: { pane: 'agents' } },
          { size: 1, node: { pane: 'terminal' } },
        ],
      },
    ],
    [
      'a group with one item',
      {
        direction: 'row',
        items: [
          {
            size: 1,
            node: {
              direction: 'column',
              items: [{ size: 1, node: { pane: 'editor' } }],
            },
          },
          { size: 1, node: { pane: 'agents' } },
          { size: 1, node: { pane: 'terminal' } },
        ],
      },
    ],
    [
      'a size of zero',
      {
        direction: 'row',
        items: [
          { size: 0, node: { pane: 'editor' } },
          { size: 1, node: { pane: 'agents' } },
          { size: 1, node: { pane: 'terminal' } },
        ],
      },
    ],
    [
      'a size that is not a number',
      {
        direction: 'row',
        items: [
          { size: '1', node: { pane: 'editor' } },
          { size: 1, node: { pane: 'agents' } },
          { size: 1, node: { pane: 'terminal' } },
        ],
      },
    ],
    [
      'sizes too large to add up',
      {
        direction: 'row',
        items: [
          { size: 1e308, node: { pane: 'editor' } },
          {
            size: 1e308,
            node: {
              direction: 'column',
              items: [
                { size: 1, node: { pane: 'agents' } },
                { size: 1, node: { pane: 'terminal' } },
              ],
            },
          },
        ],
      },
    ],
    [
      'a nested size too small to keep',
      {
        direction: 'row',
        items: [
          {
            size: 5e-324,
            node: {
              direction: 'row',
              items: [
                { size: 5e-324, node: { pane: 'editor' } },
                { size: 5e-324, node: { pane: 'agents' } },
              ],
            },
          },
          { size: 1, node: { pane: 'terminal' } },
        ],
      },
    ],
  ])('refuses %s', (_label, value) => {
    expect(parseDockTree(value)).toBeNull();
  });

  test('flattens a row nested in a row and keeps the proportions', () => {
    const parsed = parseDockTree({
      direction: 'row',
      items: [
        {
          size: 2,
          node: {
            direction: 'row',
            items: [
              { size: 1, node: { pane: 'editor' } },
              { size: 1, node: { pane: 'terminal' } },
            ],
          },
        },
        { size: 2, node: { pane: 'agents' } },
      ],
    });
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(shape(parsed)).toEqual({ row: ['editor', 'terminal', 'agents'] });
    expect(sizes(parsed)).toEqual([0.25, 0.25, 0.5]);
  });
});

describe('normalizeDockTree', () => {
  test('unwraps a group left with one item', () => {
    const tree: DockGroup = {
      direction: 'row',
      items: [
        { size: 1, node: { direction: 'column', items: [{ size: 1, node: { pane: 'editor' } }] } },
        { size: 1, node: { pane: 'agents' } },
      ],
    };
    expect(shape(normalizeDockTree(tree))).toEqual({ row: ['editor', 'agents'] });
  });
});

describe('visibleDockTree', () => {
  test('keeps every pane and the full-tree slot of each item', () => {
    const visible = visibleDockTree(DEFAULT_DOCK_TREE, everyPane) as VisibleDockGroup;
    expect(visible.path).toEqual([]);
    expect(visible.items.map((item) => item.slot)).toEqual([0, 1]);
    const column = visible.items[0]?.node as VisibleDockGroup;
    expect(column.path).toEqual([0]);
    expect(column.items.map((item) => item.slot)).toEqual([0, 1]);
  });

  test('a hidden terminal leaves the editor in its column slot, sharing the row with chat', () => {
    const visible = visibleDockTree(
      DEFAULT_DOCK_TREE,
      only('editor', 'agents'),
    ) as VisibleDockGroup;
    expect(visible.direction).toBe('row');
    expect(
      visible.items.map((item) => [item.slot, isVisibleDockLeaf(item.node) && item.node.pane]),
    ).toEqual([
      [0, 'editor'],
      [1, 'agents'],
    ]);
    expect(visible.items.reduce((sum, item) => sum + item.share, 0)).toBeCloseTo(1);
  });

  test('a single visible pane is the whole tree', () => {
    expect(visibleDockTree(DEFAULT_DOCK_TREE, only('agents'))).toEqual({ pane: 'agents' });
  });

  test('nothing visible gives no tree', () => {
    expect(visibleDockTree(DEFAULT_DOCK_TREE, only())).toBeNull();
  });
});

describe('resizeDockGroup', () => {
  test('changes the visible slots and keeps a hidden slot for when it comes back', () => {
    const tree: DockGroup = {
      direction: 'row',
      items: [
        { size: 0.5, node: { pane: 'editor' } },
        { size: 0.25, node: { pane: 'terminal' } },
        { size: 0.25, node: { pane: 'agents' } },
      ],
    };
    const resized = resizeDockGroup(
      tree,
      [],
      new Map([
        [0, 0.25],
        [2, 0.75],
      ]),
    );
    expect(sizes(resized)).toEqual([0.1875, 0.25, 0.5625]);
    const visible = visibleDockTree(resized, only('editor', 'agents')) as VisibleDockGroup;
    expect(visible.items.map((item) => Number(item.share.toFixed(4)))).toEqual([0.25, 0.75]);
  });

  test('leaves the tree alone for a path that is not a group', () => {
    expect(resizeDockGroup(DEFAULT_DOCK_TREE, [1], new Map([[0, 1]]))).toBe(DEFAULT_DOCK_TREE);
    expect(resizeDockGroup(DEFAULT_DOCK_TREE, [7], new Map([[0, 1]]))).toBe(DEFAULT_DOCK_TREE);
  });

  test('leaves the tree alone for a share that is not positive', () => {
    expect(
      resizeDockGroup(
        DEFAULT_DOCK_TREE,
        [],
        new Map([
          [0, 0],
          [1, 1],
        ]),
      ),
    ).toBe(DEFAULT_DOCK_TREE);
  });
});

describe('moveDockPane', () => {
  test('moves the terminal from under the editor to beside it, and back', () => {
    const beside = moveDockPane(DEFAULT_DOCK_TREE, 'terminal', 'editor', 'end');
    expect(shape(beside)).toEqual({ row: ['editor', 'terminal', 'agents'] });
    expect(dockPaneDirection(beside, 'terminal')).toBe('row');
    const under = moveDockPane(beside, 'terminal', 'editor', 'bottom', 0.3);
    expect(shape(under)).toEqual({ row: [{ column: ['editor', 'terminal'] }, 'agents'] });
    expect(dockPaneDirection(under, 'terminal')).toBe('column');
  });

  test('puts chat above the editor', () => {
    const moved = moveDockPane(DEFAULT_DOCK_TREE, 'agents', 'editor', 'top');
    expect(shape(moved)).toEqual({ column: ['agents', 'editor', 'terminal'] });
  });

  test('puts chat at the start of the terminal, in a row under the editor', () => {
    const moved = moveDockPane(DEFAULT_DOCK_TREE, 'agents', 'terminal', 'start');
    expect(shape(moved)).toEqual({ column: ['editor', { row: ['agents', 'terminal'] }] });
  });

  test('every move keeps all three panes, each once', () => {
    const edges = ['start', 'end', 'top', 'bottom'] as const;
    const panes: PaneId[] = ['editor', 'agents', 'terminal'];
    for (const pane of panes) {
      for (const target of panes) {
        for (const edge of edges) {
          const moved = moveDockPane(DEFAULT_DOCK_TREE, pane, target, edge);
          expect(dockTreePanes(moved).toSorted()).toEqual(['agents', 'editor', 'terminal']);
          expect(parseDockTree(JSON.parse(JSON.stringify(moved)))).not.toBeNull();
        }
      }
    }
  });

  test('moving a pane onto itself changes nothing', () => {
    expect(moveDockPane(DEFAULT_DOCK_TREE, 'editor', 'editor', 'end')).toBe(DEFAULT_DOCK_TREE);
  });
});

describe('moveDockPaneToEdge', () => {
  test('puts chat along the start edge, beside the editor and terminal column', () => {
    const moved = moveDockPaneToEdge(DEFAULT_DOCK_TREE, 'agents', 'start', 0.3);
    expect(shape(moved)).toEqual({ row: ['agents', { column: ['editor', 'terminal'] }] });
    expect(sizes(moved)).toEqual([0.3, 0.7]);
  });

  test('puts the terminal along the bottom edge, under the editor and chat', () => {
    const moved = moveDockPaneToEdge(DEFAULT_DOCK_TREE, 'terminal', 'bottom', 0.25);
    expect(shape(moved)).toEqual({ column: [{ row: ['editor', 'agents'] }, 'terminal'] });
    expect(sizes(moved)).toEqual([0.75, 0.25]);
  });

  test('puts the editor along the top edge, over a row the other two now share', () => {
    const moved = moveDockPaneToEdge(DEFAULT_DOCK_TREE, 'editor', 'top', 0.6);
    expect(shape(moved)).toEqual({ column: ['editor', { row: ['terminal', 'agents'] }] });
  });

  test('a pane already along that whole edge stays put at its size, and one only at the end of a nested row still moves', () => {
    expect(moveDockPaneToEdge(DEFAULT_DOCK_TREE, 'agents', 'end', 0.5)).toBe(DEFAULT_DOCK_TREE);
    const bottomEdgeTerminal = moveDockPaneToEdge(DEFAULT_DOCK_TREE, 'terminal', 'bottom', 0.25);
    expect(moveDockPaneToEdge(bottomEdgeTerminal, 'terminal', 'bottom', 0.4)).toBe(
      bottomEdgeTerminal,
    );
    expect(shape(moveDockPaneToEdge(bottomEdgeTerminal, 'agents', 'end', 0.3))).toEqual({
      row: [{ column: ['editor', 'terminal'] }, 'agents'],
    });
    expect(shape(moveDockPaneToEdge(bottomEdgeTerminal, 'terminal', 'end', 0.3))).toEqual({
      row: ['editor', 'agents', 'terminal'],
    });
    expect(shape(moveDockPaneToEdge(DEFAULT_DOCK_TREE, 'terminal', 'end', 0.3))).toEqual({
      row: ['editor', 'agents', 'terminal'],
    });
  });

  test('every edge keeps all three panes, each once, in a tree that reads back', () => {
    const edges = ['start', 'end', 'top', 'bottom'] as const;
    const panes: PaneId[] = ['editor', 'agents', 'terminal'];
    for (const pane of panes) {
      for (const edge of edges) {
        const moved = moveDockPaneToEdge(DEFAULT_DOCK_TREE, pane, edge, 1 / 3);
        expect(dockTreePanes(moved).toSorted()).toEqual(['agents', 'editor', 'terminal']);
        expect(parseDockTree(JSON.parse(JSON.stringify(moved)))).not.toBeNull();
      }
    }
  });
});

describe('giving space back when a pane leaves', () => {
  const sized = (node: DockNode): unknown =>
    isDockLeaf(node)
      ? node.pane
      : {
          [node.direction]: node.items.map((item) => [
            Number(item.size.toFixed(9)),
            sized(item.node),
          ]),
        };

  test('a pane docked along a whole edge gives its space back to every other pane, also after the tree is read back', () => {
    const atEdge = moveDockPaneToEdge(DEFAULT_DOCK_TREE, 'terminal', 'end', 0.3);
    const readBack = parseDockTree(JSON.parse(JSON.stringify(atEdge)));
    if (readBack === null) throw new Error('expected the tree to read back');
    for (const tree of [atEdge, readBack]) {
      const back = moveDockPane(
        tree,
        'terminal',
        'editor',
        'bottom',
        DEFAULT_BOTTOM_TERMINAL_SHARE,
      );
      expect(sized(back)).toEqual(sized(DEFAULT_DOCK_TREE));
    }
  });

  test('a pane docked beside another gives its space back to it, even when it ends up at the end of the window', () => {
    const besideEditor = moveDockPane(
      moveDockPaneToEdge(DEFAULT_DOCK_TREE, 'agents', 'start', 0.3),
      'terminal',
      'editor',
      'end',
      0.4,
    );
    expect(shape(besideEditor)).toEqual({ row: ['agents', 'editor', 'terminal'] });
    const back = moveDockPane(besideEditor, 'terminal', 'editor', 'bottom', 0.5);
    expect(sizes(back)).toEqual([0.3, 0.7]);
  });

  test('dropping a pane on the far half of its neighbour changes only those two panes', () => {
    const rightTerminal = moveDockPane(DEFAULT_DOCK_TREE, 'terminal', 'editor', 'end', 0.4);
    const moved = moveDockPane(rightTerminal, 'editor', 'terminal', 'end');
    expect(shape(moved)).toEqual({ row: ['terminal', 'editor', 'agents'] });
    expect(sizes(moved)[2]).toBe(sizes(rightTerminal)[2]);
  });
});

describe('swapDockPanes', () => {
  test('trades the places of two panes and keeps every size', () => {
    const sizeShape = (node: DockNode): unknown =>
      isDockLeaf(node)
        ? null
        : node.items.map((item) => [Number(item.size.toFixed(4)), sizeShape(item.node)]);
    const swapped = swapDockPanes(DEFAULT_DOCK_TREE, 'editor', 'agents');
    expect(shape(swapped)).toEqual({ row: [{ column: ['agents', 'terminal'] }, 'editor'] });
    expect(sizeShape(swapped)).toEqual(sizeShape(DEFAULT_DOCK_TREE));
  });
});
