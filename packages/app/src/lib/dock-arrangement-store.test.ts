import { PREFERRED_TERMINAL_RIGHT_WIDTH } from '@inkeep/open-knowledge-core/terminal-layout';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PANE_CARD_GAP_PX } from '../components/ui/pane-card.tsx';
import {
  type DockArrangement,
  type DockArrangementStorage,
  dockArrangementStorageKey,
  dockTerminalPlacement,
  legacyDockArrangement,
  readDockArrangement,
  withDockPaneAtEdge,
  withDockTerminalPlacement,
  writeDockArrangement,
} from './dock-arrangement-store.ts';
import { dockPaneMinExtent, layoutDock } from './dock-layout.ts';
import {
  bottomTerminalDockTree,
  DEFAULT_CHAT_SHARE,
  DEFAULT_DOCK_TREE,
  type DockNode,
  isDockLeaf,
  visibleDockTree,
} from './dock-tree.ts';
import type { PaneId } from './pane-visibility-store.ts';

function memoryStorage(initial: Record<string, string> = {}): DockArrangementStorage & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

function shape(node: DockNode): unknown {
  if (isDockLeaf(node)) return node.pane;
  return { [node.direction]: node.items.map((item) => shape(item.node)) };
}

function shares(node: DockNode): unknown {
  if (isDockLeaf(node)) return node.pane;
  return node.items.map((item) => [Number(item.size.toFixed(4)), shares(item.node)]);
}

function rawShares(node: DockNode): unknown {
  if (isDockLeaf(node)) return node.pane;
  return node.items.map((item) => [Number(item.size.toFixed(10)), rawShares(item.node)]);
}

function rowShare(tree: DockNode, pane: string): number | undefined {
  if (isDockLeaf(tree)) return undefined;
  return tree.items.find((item) => isDockLeaf(item.node) && item.node.pane === pane)?.size;
}

const workspace = { widthPx: 1400, heightPx: 900 };
const defaultArrangement = (): DockArrangement => legacyDockArrangement(workspace, memoryStorage());

describe('dock arrangement storage', () => {
  test('scopes the key to the project', () => {
    expect(dockArrangementStorageKey('/a/notes')).not.toBe(dockArrangementStorageKey('/b/notes'));
    expect(dockArrangementStorageKey('/a/notes')).toMatch(/^ok-dock-arrangement-v1:/);
  });

  test('a host whose origin already belongs to one project uses the unscoped name', () => {
    expect(dockArrangementStorageKey(null)).toBe('ok-dock-arrangement-v1');
  });

  test('reads back a written arrangement', () => {
    const storage = memoryStorage();
    const key = dockArrangementStorageKey('/a/notes');
    const written = withDockTerminalPlacement(defaultArrangement(), 'right');
    writeDockArrangement(key, written, storage);
    const read = readDockArrangement(key, storage);
    expect(read === null ? null : shares(read.tree)).toEqual(shares(written.tree));
    expect(read?.terminalShares).toEqual(written.terminalShares);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('says nothing when no arrangement was ever stored', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(readDockArrangement(dockArrangementStorageKey('/a/notes'), memoryStorage())).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  test.each([
    ['text that is not JSON', '{not json'],
    [
      'JSON that is not a tree',
      JSON.stringify({
        tree: { direction: 'row', items: [] },
        terminalShares: { bottom: 0.3, right: 0.5 },
      }),
    ],
    [
      'a tree missing a pane',
      JSON.stringify({
        tree: {
          direction: 'row',
          items: [
            { size: 1, node: { pane: 'editor' } },
            { size: 1, node: { pane: 'agents' } },
          ],
        },
        terminalShares: { bottom: 0.3, right: 0.5 },
      }),
    ],
    ['a tree with no terminal shares', JSON.stringify({ tree: DEFAULT_DOCK_TREE })],
    [
      'a terminal share that is not a fraction',
      JSON.stringify({ tree: DEFAULT_DOCK_TREE, terminalShares: { bottom: 0.3, right: 1 } }),
    ],
    ['a bare tree', JSON.stringify(DEFAULT_DOCK_TREE)],
  ])('gives no arrangement for %s, and names the record it ignored', (_label, raw) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const key = dockArrangementStorageKey('/a/notes');
    expect(readDockArrangement(key, memoryStorage({ [key]: raw }))).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(key);
  });

  test('gives no tree when storage itself throws, and names the key it could not use', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage: DockArrangementStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(readDockArrangement('ok-dock-arrangement-v1:blocked', storage)).toBeNull();
    expect(() =>
      writeDockArrangement('ok-dock-arrangement-v1:blocked', defaultArrangement(), storage),
    ).not.toThrow();
    expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
      expect.stringContaining('reading ok-dock-arrangement-v1:blocked failed'),
      expect.stringContaining('writing ok-dock-arrangement-v1:blocked failed'),
    ]);
  });
});

describe('legacyDockArrangement', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('a profile that never stored a layout gets the default tree', () => {
    expect(shares(defaultArrangement().tree)).toEqual(shares(DEFAULT_DOCK_TREE));
  });

  test.each(['', 'not a number'])(
    'an unreadable stored chat width or terminal height %j seeds what no stored value does',
    (value) => {
      const { tree } = legacyDockArrangement(
        workspace,
        memoryStorage({ 'ok-terminal-width-v1': value, 'ok-terminal-height-v1': value }),
      );
      expect(shape(tree)).toEqual(shape(DEFAULT_DOCK_TREE));
      expect(shares(tree)).toEqual(shares(DEFAULT_DOCK_TREE));
    },
  );

  test("a stored chat width becomes chat's share of the window", () => {
    const { tree } = legacyDockArrangement(
      workspace,
      memoryStorage({ 'ok-terminal-width-v1': '700' }),
    );
    expect(shape(tree)).toEqual({ row: [{ column: ['editor', 'terminal'] }, 'agents'] });
    expect(shares(tree)).toEqual([
      [
        0.5,
        [
          [Number((2.3 / 3.3).toFixed(4)), 'editor'],
          [Number((1 / 3.3).toFixed(4)), 'terminal'],
        ],
      ],
      [0.5, 'agents'],
    ]);
  });

  test('a stored bottom terminal height becomes its share of the column', () => {
    const { tree } = legacyDockArrangement(
      workspace,
      memoryStorage({ 'ok-terminal-height-v1': '360' }),
    );
    expect(shares(tree)).toEqual([
      [
        Number((2.5 / 3.5).toFixed(4)),
        [
          [0.6, 'editor'],
          [0.4, 'terminal'],
        ],
      ],
      [Number((1 / 3.5).toFixed(4)), 'agents'],
    ]);
  });

  test('a stored right placement puts the terminal between the editor and chat, at its preferred width as its share of the space beside the editor', () => {
    const { tree } = legacyDockArrangement(
      workspace,
      memoryStorage({ 'ok-terminal-placement-v1': 'right' }),
    );
    expect(shape(tree)).toEqual({ row: ['editor', 'terminal', 'agents'] });
    expect(dockTerminalPlacement(tree)).toBe('right');
    expect(shares(tree)).toEqual(
      shares(withDockTerminalPlacement(defaultArrangement(), 'right').tree),
    );
    expect(rowShare(tree, 'terminal')).toBeCloseTo(
      (PREFERRED_TERMINAL_RIGHT_WIDTH / 1400) * (1 - DEFAULT_CHAT_SHARE),
      10,
    );
  });

  test("a stored right width becomes the right terminal's share of the space beside the editor", () => {
    const { tree } = legacyDockArrangement(
      workspace,
      memoryStorage({ 'ok-terminal-placement-v1': 'right', 'ok-terminal-right-width-v1': '420' }),
    );
    expect(shares(tree)).toEqual([
      [Number(((2.5 / 3.5) * 0.7).toFixed(4)), 'editor'],
      [Number(((2.5 / 3.5) * 0.3).toFixed(4)), 'terminal'],
      [Number((1 / 3.5).toFixed(4)), 'agents'],
    ]);
  });

  test('a window with no size yet seeds the default shares', () => {
    const { tree } = legacyDockArrangement(
      { widthPx: 0, heightPx: 0 },
      memoryStorage({ 'ok-terminal-width-v1': '700', 'ok-terminal-height-v1': '360' }),
    );
    expect(shares(tree)).toEqual(shares(DEFAULT_DOCK_TREE));
  });

  const bottomColumn = [
    [Number((2.3 / 3.3).toFixed(4)), 'editor'],
    [Number((1 / 3.3).toFixed(4)), 'terminal'],
  ];

  test('a stored chat width wider than three fifths of the window is held to three fifths', () => {
    const { tree } = legacyDockArrangement(
      { widthPx: 1000, heightPx: 900 },
      memoryStorage({ 'ok-terminal-width-v1': '900' }),
    );
    expect(shares(tree)).toEqual([
      [0.4, bottomColumn],
      [0.6, 'agents'],
    ]);
  });

  test('a stored chat width under a tenth of the window is raised to a tenth', () => {
    const { tree } = legacyDockArrangement(
      { widthPx: 4000, heightPx: 900 },
      memoryStorage({ 'ok-terminal-width-v1': '320' }),
    );
    expect(shares(tree)).toEqual([
      [0.9, bottomColumn],
      [0.1, 'agents'],
    ]);
  });

  test('a stored terminal height under a tenth of the window is raised to a tenth', () => {
    const { tree } = legacyDockArrangement(
      { widthPx: 1400, heightPx: 2000 },
      memoryStorage({ 'ok-terminal-height-v1': '120' }),
    );
    expect(shares(tree)).toEqual([
      [
        Number((2.5 / 3.5).toFixed(4)),
        [
          [0.9, 'editor'],
          [0.1, 'terminal'],
        ],
      ],
      [Number((1 / 3.5).toFixed(4)), 'agents'],
    ]);
  });

  test("a right terminal's preferred width wider than three fifths of the window is held to three fifths of the space beside the editor", () => {
    const { tree } = legacyDockArrangement(
      { widthPx: 1000, heightPx: 900 },
      memoryStorage({ 'ok-terminal-placement-v1': 'right' }),
    );
    expect(shares(tree)).toEqual([
      [Number(((2.5 / 3.5) * 0.4).toFixed(4)), 'editor'],
      [Number(((2.5 / 3.5) * 0.6).toFixed(4)), 'terminal'],
      [Number((1 / 3.5).toFixed(4)), 'agents'],
    ]);
  });

  test('a stored right width under a tenth of the window is raised to a tenth of the space beside the editor', () => {
    const { tree } = legacyDockArrangement(
      { widthPx: 4000, heightPx: 900 },
      memoryStorage({ 'ok-terminal-placement-v1': 'right', 'ok-terminal-right-width-v1': '360' }),
    );
    expect(shares(tree)).toEqual([
      [Number(((2.5 / 3.5) * 0.9).toFixed(4)), 'editor'],
      [Number(((2.5 / 3.5) * 0.1).toFixed(4)), 'terminal'],
      [Number((1 / 3.5).toFixed(4)), 'agents'],
    ]);
  });

  test('storage that throws falls back to the default tree, and names the keys it could not read', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage: DockArrangementStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {},
    };
    expect(shares(legacyDockArrangement(workspace, storage).tree)).toEqual(
      shares(DEFAULT_DOCK_TREE),
    );
    expect(unreadLegacyKeys(warn)).toEqual(EVERY_LEGACY_KEY);
  });
});

const EVERY_LEGACY_KEY = [
  'ok-terminal-height-v1',
  'ok-terminal-placement-v1',
  'ok-terminal-right-width-v1',
  'ok-terminal-width-v1',
];

function unreadLegacyKeys(warn: { mock: { calls: unknown[][] } }): string[] {
  return warn.mock.calls
    .map(([message]) => /reading (\S+) failed/u.exec(String(message))?.[1] ?? String(message))
    .toSorted();
}

describe('legacyDockArrangement on a storage-restricted host', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis as object, 'localStorage');
    vi.restoreAllMocks();
  });

  test('a localStorage getter that throws seeds the default tree, and names every legacy key it could not read', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('access denied', 'SecurityError');
      },
    });

    expect(shares(legacyDockArrangement(workspace).tree)).toEqual(shares(DEFAULT_DOCK_TREE));
    expect(unreadLegacyKeys(warn)).toEqual(EVERY_LEGACY_KEY);
  });

  test('a host with no localStorage at all seeds the default tree, and names every legacy key it could not read', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Reflect.deleteProperty(globalThis as object, 'localStorage');

    expect(shares(legacyDockArrangement(workspace).tree)).toEqual(shares(DEFAULT_DOCK_TREE));
    expect(unreadLegacyKeys(warn)).toEqual(EVERY_LEGACY_KEY);
  });
});

describe('terminal placement on the tree', () => {
  test('moves the terminal beside the editor and back under it', () => {
    const right = withDockTerminalPlacement(defaultArrangement(), 'right');
    expect(dockTerminalPlacement(right.tree)).toBe('right');
    expect(shape(right.tree)).toEqual({ row: ['editor', 'terminal', 'agents'] });
    const bottom = withDockTerminalPlacement(right, 'bottom');
    expect(dockTerminalPlacement(bottom.tree)).toBe('bottom');
    expect(shape(bottom.tree)).toEqual({ row: [{ column: ['editor', 'terminal'] }, 'agents'] });
  });

  test('a move resizes only the terminal and the editor, and moving back returns every share', () => {
    const start = legacyDockArrangement(
      workspace,
      memoryStorage({ 'ok-terminal-width-v1': '420', 'ok-terminal-height-v1': '360' }),
    );
    let arrangement = start;
    for (let trip = 0; trip < 3; trip += 1) {
      arrangement = withDockTerminalPlacement(arrangement, 'right');
      expect(rowShare(arrangement.tree, 'agents')).toBeCloseTo(0.3, 10);
      expect(rowShare(arrangement.tree, 'terminal')).toBeCloseTo(
        (PREFERRED_TERMINAL_RIGHT_WIDTH / 1400) * 0.7,
        10,
      );
      arrangement = withDockTerminalPlacement(arrangement, 'bottom');
      expect(rawShares(arrangement.tree)).toEqual(rawShares(start.tree));
    }
  });

  test('moving the terminal to the bottom and back returns the right-hand shares', () => {
    const start = legacyDockArrangement(
      workspace,
      memoryStorage({ 'ok-terminal-placement-v1': 'right', 'ok-terminal-right-width-v1': '420' }),
    );
    const bottom = withDockTerminalPlacement(start, 'bottom');
    expect(rowShare(bottom.tree, 'agents')).toBeCloseTo(DEFAULT_CHAT_SHARE, 10);
    expect(rawShares(withDockTerminalPlacement(bottom, 'right').tree)).toEqual(
      rawShares(start.tree),
    );
  });

  test('leaves the arrangement alone when the terminal is already there', () => {
    const arrangement = defaultArrangement();
    expect(withDockTerminalPlacement(arrangement, 'bottom')).toBe(arrangement);
  });
});

describe('the first move right at a 1440px window', () => {
  function widthsAfterMovingRight(isVisible: (pane: PaneId) => boolean) {
    const seeded = legacyDockArrangement({ widthPx: 1440, heightPx: 900 }, memoryStorage());
    const { tree } = withDockTerminalPlacement(seeded, 'right');
    const layout = layoutDock(
      visibleDockTree(tree, isVisible),
      { x: 0, y: 0, width: 1440, height: 900 },
      PANE_CARD_GAP_PX,
      dockPaneMinExtent,
    );
    return Object.fromEntries(
      [...layout.panes].map(([pane, rect]) => [pane, Math.round(rect.width)]),
    );
  }

  test('with Agents open the terminal takes its share beside the editor, and the editor keeps more than its minimum', () => {
    expect(widthsAfterMovingRight(() => true)).toEqual({ editor: 494, terminal: 523, agents: 407 });
  });

  test('with Agents closed the terminal opens at about its preferred width', () => {
    expect(widthsAfterMovingRight((pane) => pane !== 'agents')).toEqual({
      editor: 696,
      terminal: 736,
    });
  });
});

describe('moving the Terminal back and forth', () => {
  const sized = (node: DockNode): unknown =>
    isDockLeaf(node)
      ? node.pane
      : {
          [node.direction]: node.items.map((item) => [
            Number(item.size.toFixed(9)),
            sized(item.node),
          ]),
        };
  const EDGES = ['start', 'end', 'top', 'bottom'] as const;
  const STARTS: ReadonlyArray<
    readonly [string, (arrangement: DockArrangement) => DockArrangement]
  > = [
    ...(['agents', 'editor'] as const).flatMap((pane) =>
      EDGES.map(
        (edge) =>
          [
            `${pane} along the ${edge} edge`,
            (arrangement: DockArrangement) => withDockPaneAtEdge(arrangement, pane, edge),
          ] as const,
      ),
    ),
    [
      'the Terminal along the right edge',
      (arrangement) => withDockPaneAtEdge(arrangement, 'terminal', 'end'),
    ],
    [
      'the Terminal toggled right',
      (arrangement) => withDockTerminalPlacement(arrangement, 'right'),
    ],
  ];

  test.each(STARTS)(
    'from %s, toggling the Terminal over and back keeps every size from the first round on',
    (_name, arrange) => {
      const start = arrange(
        legacyDockArrangement({ widthPx: 1440, heightPx: 900 }, memoryStorage()),
      );
      const placement = dockTerminalPlacement(start.tree);
      const away = placement === 'bottom' ? 'right' : 'bottom';
      const roundTrip = (arrangement: DockArrangement) =>
        withDockTerminalPlacement(withDockTerminalPlacement(arrangement, away), placement);
      const first = roundTrip(start);
      let current = first;
      for (let round = 0; round < 5; round += 1) current = roundTrip(current);
      expect(sized(current.tree)).toEqual(sized(first.tree));
      expect(current.terminalShares.bottom).toBeCloseTo(first.terminalShares.bottom, 9);
      expect(current.terminalShares.right).toBeCloseTo(first.terminalShares.right, 9);
    },
  );

  test('a move to the right edge and back under the editor returns the arrangement it started from', () => {
    const start = legacyDockArrangement({ widthPx: 1440, heightPx: 900 }, memoryStorage());
    const back = withDockTerminalPlacement(withDockPaneAtEdge(start, 'terminal', 'end'), 'bottom');
    expect(sized(back.tree)).toEqual(sized(start.tree));
  });
});

describe('moving the Terminal to a workspace edge', () => {
  test('a move to an edge in the Terminal’s current placement keeps the size it has', () => {
    const arrangement: DockArrangement = {
      tree: bottomTerminalDockTree(DEFAULT_CHAT_SHARE, 0.5),
      terminalShares: { bottom: 0.3, right: 0.45 },
    };
    const moved = withDockPaneAtEdge(arrangement, 'terminal', 'bottom');
    expect(shape(moved.tree)).toEqual({ column: [{ row: ['editor', 'agents'] }, 'terminal'] });
    expect(rowShare(moved.tree, 'terminal')).toBeCloseTo(0.5, 10);
    expect(moved.terminalShares).toEqual(arrangement.terminalShares);
  });

  function widthsAfterMovingToTheRightEdge(isVisible: (pane: PaneId) => boolean) {
    const seeded = legacyDockArrangement({ widthPx: 1440, heightPx: 900 }, memoryStorage());
    const { tree } = withDockPaneAtEdge(seeded, 'terminal', 'end');
    const layout = layoutDock(
      visibleDockTree(tree, isVisible),
      { x: 0, y: 0, width: 1440, height: 900 },
      PANE_CARD_GAP_PX,
      dockPaneMinExtent,
    );
    return Object.fromEntries(
      [...layout.panes].map(([pane, rect]) => [pane, Math.round(rect.width)]),
    );
  }

  test('the first move to the right edge at a 1440px window opens the Terminal as wide as the first move right while Agents is closed', () => {
    expect(widthsAfterMovingToTheRightEdge((pane) => pane !== 'agents')).toEqual({
      editor: 696,
      terminal: 736,
    });
  });

  test('the first move to the right edge at a 1440px window keeps the editor’s share of the split with Agents open, down to the Agents minimum', () => {
    expect(widthsAfterMovingToTheRightEdge(() => true)).toEqual({
      editor: 551,
      agents: 290,
      terminal: 583,
    });
  });
});
