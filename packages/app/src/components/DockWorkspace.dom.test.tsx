import * as actualLinguiMacro from '@lingui/react/macro';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { type ReactNode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { DockExtent, DockLayout } from '@/lib/dock-layout';
import { DEFAULT_DOCK_TREE, type DockNode, moveDockPane } from '@/lib/dock-tree';
import type { PaneId } from '@/lib/pane-visibility-store';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

const { DockWorkspace } = await import('./DockWorkspace');

const WIDTH = 1200;
const HEIGHT = 800;
const GAP = 8;
const MINS: Record<PaneId, DockExtent> = {
  editor: { width: 340, height: 180 },
  agents: { width: 290, height: 170 },
  terminal: { width: 325, height: 120 },
};
const LABELS: Record<PaneId, string> = { editor: 'Editor', agents: 'Agents', terminal: 'Terminal' };
const EVERY_PANE: Record<PaneId, boolean> = { editor: true, agents: true, terminal: true };

let direction = 'ltr';
let workspaceSize = { width: WIDTH, height: HEIGHT };
let resizeCallbacks: ResizeObserverCallback[] = [];

beforeEach(() => {
  direction = 'ltr';
  workspaceSize = { width: WIDTH, height: HEIGHT };
  resizeCallbacks = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const { width, height } = this.hasAttribute('data-dock-workspace')
      ? workspaceSize
      : { width: 0, height: 0 };
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON() {},
    } as DOMRect;
  });
  const realComputedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const style = realComputedStyle(element, pseudo);
    return new Proxy(style, {
      get(target, property) {
        if (property === 'direction') return direction;
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function unit(pane: PaneId): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-dock-unit="${pane}"]`);
  if (element === null) throw new Error(`no ${pane} unit`);
  return element;
}

function px(
  element: HTMLElement,
  property: 'width' | 'height' | 'insetInlineStart' | 'insetBlockStart',
) {
  return Number.parseFloat(element.style[property]);
}

function Workspace({
  tree,
  visible = EVERY_PANE,
  onTreeChange = () => {},
  onLayoutChange,
  units,
  redockable,
}: {
  tree: DockNode;
  visible?: Record<PaneId, boolean>;
  onTreeChange?: (update: (tree: DockNode) => DockNode) => void;
  onLayoutChange?: (layout: DockLayout) => void;
  units?: Record<PaneId, ReactNode>;
  redockable?: boolean;
}) {
  return (
    <DockWorkspace
      tree={tree}
      visible={visible}
      units={units ?? { editor: 'editor', agents: 'agents', terminal: 'terminal' }}
      gap={GAP}
      minExtent={(pane) => MINS[pane]}
      paneLabel={(pane) => LABELS[pane]}
      onTreeChange={onTreeChange}
      onLayoutChange={onLayoutChange}
      redockable={redockable}
    />
  );
}

const HEADED_UNITS: Record<PaneId, ReactNode> = {
  editor: (
    <header data-dock-handle="" data-testid="editor-handle">
      Editor tabs
    </header>
  ),
  agents: (
    <header data-dock-handle="" data-testid="agents-handle">
      Agent chats
      <button type="button">New chat</button>
    </header>
  ),
  terminal: (
    <header data-dock-handle="" data-testid="terminal-handle">
      Terminal sessions
    </header>
  ),
};

function RedockHarness({ visible }: { visible?: Record<PaneId, boolean> }) {
  const [tree, setTree] = useState<DockNode>(DEFAULT_DOCK_TREE);
  return (
    <Workspace
      tree={tree}
      visible={visible}
      onTreeChange={setTree}
      units={HEADED_UNITS}
      redockable
    />
  );
}

interface Box {
  readonly start: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

function box(pane: PaneId): Box {
  return boxOf(unit(pane));
}

function boxOf(element: HTMLElement): Box {
  return {
    start: px(element, 'insetInlineStart'),
    top: px(element, 'insetBlockStart'),
    width: px(element, 'width'),
    height: px(element, 'height'),
  };
}

function dragHeader(
  pane: PaneId,
  to: { clientX: number; clientY: number },
  { release = true }: { release?: boolean } = {},
) {
  const from = box(pane);
  const handle = screen.getByTestId(`${pane}-handle`);
  const start = { clientX: from.start + 20, clientY: from.top + 10 };
  fireEvent.pointerDown(handle, { button: 0, buttons: 1, pointerId: 7, ...start });
  fireEvent.pointerMove(handle, { buttons: 1, pointerId: 7, ...to });
  if (release) fireEvent.pointerUp(handle, { pointerId: 7, ...to });
}

function chip(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[data-dock-drag-chip]');
}

function dropZone(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-dock-drop-zone]');
}

describe('DockWorkspace', () => {
  test('places each unit from the tree, with the gap between them', () => {
    render(<Workspace tree={DEFAULT_DOCK_TREE} />);
    const editor = unit('editor');
    const terminal = unit('terminal');
    const agents = unit('agents');
    expect(px(editor, 'insetInlineStart')).toBe(0);
    expect(px(agents, 'insetInlineStart')).toBe(px(editor, 'width') + GAP);
    expect(px(agents, 'insetInlineStart') + px(agents, 'width')).toBe(WIDTH);
    expect(px(terminal, 'insetBlockStart')).toBe(px(editor, 'height') + GAP);
    expect(px(terminal, 'insetBlockStart') + px(terminal, 'height')).toBe(HEIGHT);
  });

  test('lays the units out again when the workspace is resized, keeping their shares', () => {
    render(<Workspace tree={DEFAULT_DOCK_TREE} />);
    const agentsShare = px(unit('agents'), 'width') / (WIDTH - GAP);

    workspaceSize = { width: 1100, height: 600 };
    act(() => {
      for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
    });

    expect(px(unit('agents'), 'insetInlineStart') + px(unit('agents'), 'width')).toBe(1100);
    expect(px(unit('agents'), 'height')).toBe(600);
    expect(px(unit('terminal'), 'insetBlockStart') + px(unit('terminal'), 'height')).toBe(600);
    expect(px(unit('agents'), 'width') / (1100 - GAP)).toBeCloseTo(agentsShare, 2);
  });

  test('keeps a pane that is off inside the workspace when the workspace narrows', () => {
    const { rerender } = render(<Workspace tree={DEFAULT_DOCK_TREE} />);
    rerender(<Workspace tree={DEFAULT_DOCK_TREE} visible={{ ...EVERY_PANE, agents: false }} />);
    const agents = unit('agents');
    expect(px(agents, 'insetInlineStart')).toBeGreaterThan(600);

    workspaceSize = { width: 600, height: 500 };
    act(() => {
      for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
    });

    expect(agents.classList.contains('invisible')).toBe(true);
    expect(px(agents, 'insetInlineStart') + px(agents, 'width')).toBeLessThanOrEqual(600);
    expect(px(agents, 'insetBlockStart') + px(agents, 'height')).toBeLessThanOrEqual(500);
    expect(px(unit('editor'), 'insetInlineStart') + px(unit('editor'), 'width')).toBe(600);
  });

  test('hides a pane that was never on and gives its room to the others', () => {
    render(<Workspace tree={DEFAULT_DOCK_TREE} visible={{ ...EVERY_PANE, terminal: false }} />);
    expect(unit('terminal').hidden).toBe(true);
    expect(unit('terminal').hasAttribute('inert')).toBe(true);
    expect(px(unit('editor'), 'height')).toBe(HEIGHT);
    expect(screen.getAllByRole('separator')).toHaveLength(1);
  });

  test('keeps a pane that turns off at its last size, invisible and inert, so its content does not reflow', () => {
    const { rerender } = render(<Workspace tree={DEFAULT_DOCK_TREE} />);
    const width = px(unit('editor'), 'width');
    const height = px(unit('editor'), 'height');
    rerender(<Workspace tree={DEFAULT_DOCK_TREE} visible={{ ...EVERY_PANE, editor: false }} />);
    const editor = unit('editor');
    expect(editor.hidden).toBe(false);
    expect(editor.hasAttribute('inert')).toBe(true);
    expect(editor.classList.contains('invisible')).toBe(true);
    expect(px(editor, 'width')).toBe(width);
    expect(px(editor, 'height')).toBe(height);
    expect(px(unit('terminal'), 'insetBlockStart')).toBe(0);
  });

  test('names each seam after the pane it resizes and reports its position', () => {
    render(<Workspace tree={DEFAULT_DOCK_TREE} />);
    const agentsSeam = screen.getByRole('separator', { name: 'Resize Agents' });
    expect(agentsSeam.getAttribute('aria-orientation')).toBe('vertical');
    expect(agentsSeam.getAttribute('aria-controls')).toBe('dock-unit-agents');
    const terminalSeam = screen.getByRole('separator', { name: 'Resize Terminal' });
    expect(terminalSeam.getAttribute('aria-orientation')).toBe('horizontal');
    expect(terminalSeam.getAttribute('aria-controls')).toBe('dock-unit-terminal');
    const now = Number(agentsSeam.getAttribute('aria-valuenow'));
    expect(now).toBe(Math.round((px(unit('agents'), 'width') / (WIDTH - GAP)) * 100));
    expect(now).toBeGreaterThanOrEqual(Number(agentsSeam.getAttribute('aria-valuemin')));
    expect(now).toBeLessThanOrEqual(Number(agentsSeam.getAttribute('aria-valuemax')));
  });

  test('arrow keys move a seam by a step, Home shrinks the pane it names to its minimum and End grows it to its maximum', () => {
    function Harness() {
      const [tree, setTree] = useState<DockNode>(DEFAULT_DOCK_TREE);
      return <Workspace tree={tree} onTreeChange={setTree} />;
    }
    render(<Harness />);
    const seam = screen.getByRole('separator', { name: 'Resize Agents' });
    const before = px(unit('editor'), 'width');
    fireEvent.keyDown(seam, { key: 'ArrowRight' });
    expect(px(unit('editor'), 'width')).toBe(before + 16);
    fireEvent.keyDown(seam, { key: 'ArrowLeft', shiftKey: true });
    expect(px(unit('editor'), 'width')).toBe(before + 16 - 64);
    fireEvent.keyDown(seam, { key: 'Home' });
    expect(px(unit('agents'), 'width')).toBe(MINS.agents.width);
    expect(seam.getAttribute('aria-valuenow')).toBe(seam.getAttribute('aria-valuemin'));
    fireEvent.keyDown(seam, { key: 'End' });
    expect(px(unit('editor'), 'width')).toBe(MINS.editor.width);
    expect(seam.getAttribute('aria-valuenow')).toBe(seam.getAttribute('aria-valuemax'));
  });

  test('up and down arrows move a seam between stacked panes', () => {
    function Harness() {
      const [tree, setTree] = useState<DockNode>(DEFAULT_DOCK_TREE);
      return <Workspace tree={tree} onTreeChange={setTree} />;
    }
    render(<Harness />);
    const seam = screen.getByRole('separator', { name: 'Resize Terminal' });
    const before = px(unit('editor'), 'height');
    fireEvent.keyDown(seam, { key: 'ArrowUp' });
    expect(px(unit('editor'), 'height')).toBe(before - 16);
    fireEvent.keyDown(seam, { key: 'ArrowDown', shiftKey: true });
    expect(px(unit('editor'), 'height')).toBe(before - 16 + 64);
    fireEvent.keyDown(seam, { key: 'ArrowLeft' });
    expect(px(unit('editor'), 'height')).toBe(before - 16 + 64);
  });

  test.each(['altKey', 'ctrlKey', 'metaKey'] as const)(
    'a seam key pressed with %s leaves the layout alone and reaches the shortcut that owns it',
    (modifier) => {
      function Harness() {
        const [tree, setTree] = useState<DockNode>(DEFAULT_DOCK_TREE);
        return <Workspace tree={tree} onTreeChange={setTree} />;
      }
      render(<Harness />);
      const agentsSeam = screen.getByRole('separator', { name: 'Resize Agents' });
      const terminalSeam = screen.getByRole('separator', { name: 'Resize Terminal' });
      const width = px(unit('editor'), 'width');
      const height = px(unit('editor'), 'height');
      for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
        expect(fireEvent.keyDown(agentsSeam, { key, [modifier]: true })).toBe(true);
      }
      for (const key of ['ArrowUp', 'ArrowDown']) {
        expect(fireEvent.keyDown(terminalSeam, { key, [modifier]: true, shiftKey: true })).toBe(
          true,
        );
      }
      expect(px(unit('editor'), 'width')).toBe(width);
      expect(px(unit('editor'), 'height')).toBe(height);
      fireEvent.keyDown(agentsSeam, { key: 'ArrowRight' });
      expect(px(unit('editor'), 'width')).toBe(width + 16);
    },
  );

  test('right to left, the arrow toward the start grows the pane before the seam', () => {
    direction = 'rtl';
    function Harness() {
      const [tree, setTree] = useState<DockNode>(DEFAULT_DOCK_TREE);
      return <Workspace tree={tree} onTreeChange={setTree} />;
    }
    render(<Harness />);
    const seam = screen.getByRole('separator', { name: 'Resize Agents' });
    const before = px(unit('editor'), 'width');
    fireEvent.keyDown(seam, { key: 'ArrowLeft' });
    expect(px(unit('editor'), 'width')).toBe(before + 16);
  });

  test('a switch to right to left after mount turns the arrow keys and a drag around', () => {
    function Harness() {
      const [tree, setTree] = useState<DockNode>(DEFAULT_DOCK_TREE);
      return <Workspace tree={tree} onTreeChange={setTree} />;
    }
    render(<Harness />);
    direction = 'rtl';
    const seam = screen.getByRole('separator', { name: 'Resize Agents' });
    const before = px(unit('editor'), 'width');

    fireEvent.keyDown(seam, { key: 'ArrowLeft' });
    expect(px(unit('editor'), 'width')).toBe(before + 16);

    fireEvent.pointerDown(seam, { button: 0, pointerId: 1, clientX: 500 });
    fireEvent.pointerMove(seam, { pointerId: 1, clientX: 470 });
    fireEvent.pointerUp(seam, { pointerId: 1, clientX: 470 });
    expect(px(unit('editor'), 'width')).toBe(before + 16 + 30);
  });

  test('a drag whose seam goes away ends, and the remaining units take the pointer again', () => {
    const onTreeChange = vi.fn();
    const { rerender } = render(<Workspace tree={DEFAULT_DOCK_TREE} onTreeChange={onTreeChange} />);
    const workspace = document.querySelector('[data-dock-workspace]');
    const seam = screen.getByRole('separator', { name: 'Resize Terminal' });
    fireEvent.pointerDown(seam, { button: 0, pointerId: 1, clientY: 500 });
    fireEvent.pointerMove(seam, { pointerId: 1, clientY: 450 });
    expect(workspace?.hasAttribute('data-dragging')).toBe(true);
    expect(unit('editor').classList.contains('pointer-events-none')).toBe(true);

    rerender(
      <Workspace
        tree={DEFAULT_DOCK_TREE}
        visible={{ ...EVERY_PANE, terminal: false }}
        onTreeChange={onTreeChange}
      />,
    );

    expect(screen.queryByRole('separator', { name: 'Resize Terminal' })).toBeNull();
    expect(workspace?.hasAttribute('data-dragging')).toBe(false);
    expect(unit('editor').classList.contains('pointer-events-none')).toBe(false);
    expect(unit('agents').classList.contains('pointer-events-none')).toBe(false);
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 450 });
    expect(onTreeChange).not.toHaveBeenCalled();
  });

  test('a drag follows the pointer anywhere in the window and ends on its release there', () => {
    function Harness({ visible }: { visible: Record<PaneId, boolean> }) {
      const [tree, setTree] = useState<DockNode>(DEFAULT_DOCK_TREE);
      return <Workspace tree={tree} visible={visible} onTreeChange={setTree} />;
    }
    const { rerender } = render(<Harness visible={EVERY_PANE} />);
    const workspace = document.querySelector('[data-dock-workspace]');
    const seam = screen.getByRole('separator', { name: 'Resize Agents' });
    const before = px(unit('editor'), 'width');
    fireEvent.pointerDown(seam, { button: 0, pointerId: 1, clientX: before });
    rerender(<Harness visible={{ ...EVERY_PANE, terminal: false }} />);

    fireEvent.pointerMove(window, { pointerId: 1, clientX: before - 100 });
    expect(px(unit('editor'), 'width')).toBe(before - 100);
    fireEvent.pointerUp(window, { pointerId: 1, clientX: before - 100 });

    expect(workspace?.hasAttribute('data-dragging')).toBe(false);
    expect(px(unit('editor'), 'width')).toBe(before - 100);
  });

  test('a drag ends when the tree changes under it, and its release keeps the new tree', () => {
    let replaceTree: (tree: DockNode) => void = () => {};
    let ownerTree: DockNode = DEFAULT_DOCK_TREE;
    function Harness() {
      const [tree, setTree] = useState<DockNode>(DEFAULT_DOCK_TREE);
      replaceTree = setTree;
      ownerTree = tree;
      return <Workspace tree={tree} onTreeChange={setTree} />;
    }
    render(<Harness />);
    const workspace = document.querySelector('[data-dock-workspace]');
    const seam = screen.getByRole('separator', { name: 'Resize Agents' });
    const before = px(unit('editor'), 'width');
    fireEvent.pointerDown(seam, { button: 0, pointerId: 1, clientX: before });
    fireEvent.pointerMove(seam, { pointerId: 1, clientX: before - 100 });
    expect(workspace?.hasAttribute('data-dragging')).toBe(true);

    const moved = moveDockPane(DEFAULT_DOCK_TREE, 'terminal', 'editor', 'end');
    act(() => replaceTree(moved));
    expect(workspace?.hasAttribute('data-dragging')).toBe(false);
    fireEvent.pointerUp(seam, { pointerId: 1, clientX: before - 100 });

    expect(ownerTree).toBe(moved);
  });

  test('a resize handed to the owner leaves alone any tree but the one it measured', () => {
    const onTreeChange = vi.fn();
    render(<Workspace tree={DEFAULT_DOCK_TREE} onTreeChange={onTreeChange} />);
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize Agents' }), {
      key: 'ArrowLeft',
    });
    const update = onTreeChange.mock.calls[0]?.[0] as ((tree: DockNode) => DockNode) | undefined;
    if (update === undefined) throw new Error('the seam handed the owner no resize');
    const moved = moveDockPane(DEFAULT_DOCK_TREE, 'terminal', 'editor', 'end');

    expect(update(moved)).toBe(moved);
    expect(update(DEFAULT_DOCK_TREE)).not.toBe(DEFAULT_DOCK_TREE);
  });

  test('a click on a seam, or a key that would push it past its bound, leaves the tree alone', () => {
    const changes: unknown[] = [];
    function Harness() {
      const [tree, setTree] = useState<DockNode>(DEFAULT_DOCK_TREE);
      return (
        <Workspace
          tree={tree}
          onTreeChange={(next) => {
            changes.push(next);
            setTree(next);
          }}
        />
      );
    }
    render(<Harness />);
    const workspace = document.querySelector('[data-dock-workspace]');
    const seam = screen.getByRole('separator', { name: 'Resize Agents' });

    fireEvent.pointerDown(seam, { button: 0, pointerId: 1, clientX: 500 });
    expect(workspace?.hasAttribute('data-dragging')).toBe(true);
    fireEvent.pointerUp(seam, { pointerId: 1, clientX: 500 });
    expect(workspace?.hasAttribute('data-dragging')).toBe(false);
    expect(changes).toHaveLength(0);

    fireEvent.keyDown(seam, { key: 'Home' });
    expect(changes).toHaveLength(1);
    fireEvent.keyDown(seam, { key: 'Home' });
    expect(changes).toHaveLength(1);
  });

  test('a focused seam keeps focus when hiding a pane or moving the terminal changes what it follows', () => {
    const right = moveDockPane(DEFAULT_DOCK_TREE, 'terminal', 'editor', 'end');
    const { rerender } = render(<Workspace tree={DEFAULT_DOCK_TREE} />);
    const seam = screen.getByRole('separator', { name: 'Resize Agents' });
    act(() => seam.focus());
    expect(document.activeElement).toBe(seam);

    rerender(<Workspace tree={DEFAULT_DOCK_TREE} visible={{ ...EVERY_PANE, terminal: false }} />);
    expect(document.activeElement).toBe(seam);
    expect(seam.getAttribute('aria-label')).toBe('Resize Agents');

    rerender(<Workspace tree={right} />);
    expect(document.activeElement).toBe(seam);

    rerender(<Workspace tree={right} visible={{ ...EVERY_PANE, terminal: false }} />);
    expect(document.activeElement).toBe(seam);
    expect(seam.getAttribute('aria-label')).toBe('Resize Agents');
  });

  test('units and seams sit in document order the way they are arranged, and a placement move moves no unit', () => {
    function order() {
      return Array.from(
        document.querySelectorAll('[data-dock-workspace] [data-dock-unit], [role="separator"]'),
        (element) => element.getAttribute('data-dock-unit') ?? element.getAttribute('aria-label'),
      );
    }
    const { rerender } = render(<Workspace tree={DEFAULT_DOCK_TREE} />);
    expect(order()).toEqual(['editor', 'Resize Terminal', 'terminal', 'Resize Agents', 'agents']);
    const workspace = document.querySelector('[data-dock-workspace]');
    if (workspace === null) throw new Error('no dock workspace');
    const removed: Node[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) removed.push(...record.removedNodes);
    });
    observer.observe(workspace, { childList: true });

    rerender(<Workspace tree={moveDockPane(DEFAULT_DOCK_TREE, 'terminal', 'editor', 'end')} />);
    for (const record of observer.takeRecords()) removed.push(...record.removedNodes);
    observer.disconnect();

    expect(order()).toEqual(['editor', 'Resize Terminal', 'terminal', 'Resize Agents', 'agents']);
    expect(
      removed.filter((node) => node instanceof HTMLElement && node.hasAttribute('data-dock-unit')),
    ).toEqual([]);
  });

  test('a pointer drag previews the move and commits it once on release', () => {
    const onTreeChange = vi.fn();
    render(<Workspace tree={DEFAULT_DOCK_TREE} onTreeChange={onTreeChange} />);
    const seam = screen.getByRole('separator', { name: 'Resize Agents' });
    const before = px(unit('editor'), 'width');
    fireEvent.pointerDown(seam, { button: 0, pointerId: 1, clientX: before });
    fireEvent.pointerMove(seam, { pointerId: 1, clientX: before - 100 });
    expect(px(unit('editor'), 'width')).toBe(before - 100);
    expect(onTreeChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(seam, { pointerId: 1, clientX: before - 100 });
    expect(onTreeChange).toHaveBeenCalledTimes(1);
  });

  test('a drag with a button other than the primary one does nothing', () => {
    const onTreeChange = vi.fn();
    render(<Workspace tree={DEFAULT_DOCK_TREE} onTreeChange={onTreeChange} />);
    const workspace = document.querySelector('[data-dock-workspace]');
    const seam = screen.getByRole('separator', { name: 'Resize Agents' });
    const before = px(unit('editor'), 'width');
    fireEvent.pointerDown(seam, { button: 2, pointerId: 1, clientX: before });
    expect(workspace?.hasAttribute('data-dragging')).toBe(false);
    fireEvent.pointerMove(seam, { pointerId: 1, clientX: before - 100 });
    fireEvent.pointerUp(seam, { pointerId: 1, clientX: before - 100 });
    expect(px(unit('editor'), 'width')).toBe(before);
    expect(onTreeChange).not.toHaveBeenCalled();
  });

  test('another pointer neither moves nor ends a drag', () => {
    function Harness() {
      const [tree, setTree] = useState<DockNode>(DEFAULT_DOCK_TREE);
      return <Workspace tree={tree} onTreeChange={setTree} />;
    }
    render(<Harness />);
    const workspace = document.querySelector('[data-dock-workspace]');
    const seam = screen.getByRole('separator', { name: 'Resize Agents' });
    const before = px(unit('editor'), 'width');
    fireEvent.pointerDown(seam, { button: 0, pointerId: 1, clientX: before });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: before - 200 });
    fireEvent.pointerCancel(window, { pointerId: 2 });
    fireEvent.pointerUp(window, { pointerId: 2, clientX: before - 200 });
    expect(workspace?.hasAttribute('data-dragging')).toBe(true);
    expect(px(unit('editor'), 'width')).toBe(before);

    fireEvent.pointerMove(window, { pointerId: 1, clientX: before - 100 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: before - 100 });
    expect(workspace?.hasAttribute('data-dragging')).toBe(false);
    expect(px(unit('editor'), 'width')).toBe(before - 100);
  });

  test('a workspace unmounted mid-drag hands the owner nothing when the pointer moves on or lifts', () => {
    const onTreeChange = vi.fn();
    const { unmount } = render(<Workspace tree={DEFAULT_DOCK_TREE} onTreeChange={onTreeChange} />);
    const seam = screen.getByRole('separator', { name: 'Resize Agents' });
    const before = px(unit('editor'), 'width');
    fireEvent.pointerDown(seam, { button: 0, pointerId: 1, clientX: before });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: before - 100 });
    expect(document.querySelector('[data-dock-workspace]')?.hasAttribute('data-dragging')).toBe(
      true,
    );

    unmount();
    fireEvent.pointerMove(window, { pointerId: 1, clientX: before - 150 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: before - 150 });

    expect(onTreeChange).not.toHaveBeenCalled();
  });

  test('a cancelled drag puts the seam back', () => {
    const onTreeChange = vi.fn();
    render(<Workspace tree={DEFAULT_DOCK_TREE} onTreeChange={onTreeChange} />);
    const seam = screen.getByRole('separator', { name: 'Resize Agents' });
    const before = px(unit('editor'), 'width');
    fireEvent.pointerDown(seam, { button: 0, pointerId: 1, clientX: before });
    fireEvent.pointerMove(seam, { pointerId: 1, clientX: before - 100 });
    fireEvent.pointerCancel(seam, { pointerId: 1 });
    expect(px(unit('editor'), 'width')).toBe(before);
    expect(onTreeChange).not.toHaveBeenCalled();
  });

  test('reports the layout it drew', () => {
    const onLayoutChange = vi.fn();
    render(<Workspace tree={DEFAULT_DOCK_TREE} onLayoutChange={onLayoutChange} />);
    const layout = onLayoutChange.mock.calls.at(-1)?.[0] as DockLayout;
    expect([...layout.panes.keys()].toSorted()).toEqual(['agents', 'editor', 'terminal']);
  });

  test('keeps each unit mounted when the tree moves it', () => {
    let mounts = 0;
    function Counter({ name }: { name: string }) {
      const [id] = useState(() => {
        mounts += 1;
        return mounts;
      });
      return <span data-testid={name}>{id}</span>;
    }
    const units = {
      editor: <Counter name="editor-content" />,
      agents: <Counter name="agents-content" />,
      terminal: <Counter name="terminal-content" />,
    };
    const { rerender } = render(<Workspace tree={DEFAULT_DOCK_TREE} units={units} />);
    expect(mounts).toBe(3);
    act(() => {
      rerender(
        <Workspace
          tree={moveDockPane(DEFAULT_DOCK_TREE, 'terminal', 'agents', 'top')}
          units={units}
        />,
      );
    });
    expect(mounts).toBe(3);
    expect(px(unit('terminal'), 'insetInlineStart')).toBe(px(unit('agents'), 'insetInlineStart'));
  });
});

describe('DockWorkspace re-docking', () => {
  test('dragging a tab strip onto the start edge of another unit docks it where the outline shows', () => {
    render(<RedockHarness />);
    const editor = box('editor');
    const target = { clientX: editor.start + 10, clientY: editor.top + editor.height / 2 };

    dragHeader('agents', target, { release: false });
    const zone = dropZone();
    expect(zone?.dataset).toMatchObject({ dockDropZone: 'start', dockDropPane: 'editor' });
    if (zone === null) throw new Error('no drop zone outlined');
    const outline = boxOf(zone);
    expect(chip()?.textContent).toBe('Agents');
    expect(document.querySelector('[data-redocking="agents"]')).not.toBeNull();
    fireEvent.pointerUp(screen.getByTestId('agents-handle'), { pointerId: 7, ...target });

    const agents = box('agents');
    const moved = box('editor');
    expect(agents).toEqual(outline);
    expect(agents.start).toBe(editor.start);
    expect(agents.top).toBe(moved.top);
    expect(moved.start).toBeGreaterThan(agents.start);
    expect(box('terminal').width).toBe(WIDTH);
    expect(chip()).toBeNull();
    expect(dropZone()).toBeNull();
  });

  test('dropping a tab strip on the middle of another unit trades the two places', () => {
    render(<RedockHarness />);
    const editor = box('editor');
    const agents = box('agents');

    dragHeader('agents', {
      clientX: editor.start + editor.width / 2,
      clientY: editor.top + editor.height / 2,
    });

    expect(box('agents')).toEqual(editor);
    expect(box('editor')).toEqual(agents);
  });

  test('a press on a control inside the tab strip starts no drag', () => {
    render(<RedockHarness />);
    const before = layoutBoxes();
    const editor = box('editor');
    const button = screen.getByRole('button', { name: 'New chat' });
    fireEvent.pointerDown(button, {
      button: 0,
      buttons: 1,
      pointerId: 7,
      clientX: 1100,
      clientY: 10,
    });
    fireEvent.pointerMove(button, {
      buttons: 1,
      pointerId: 7,
      clientX: editor.start + 10,
      clientY: 300,
    });
    expect(chip()).toBeNull();
    fireEvent.pointerUp(button, { pointerId: 7, clientX: editor.start + 10, clientY: 300 });

    expect(layoutBoxes()).toEqual(before);
  });

  test('a press that moves less than the start distance shows no drag and leaves the layout alone', () => {
    render(<RedockHarness />);
    const before = layoutBoxes();
    const agents = box('agents');
    const nudged = { clientX: agents.start + 22, clientY: agents.top + 11 };

    dragHeader('agents', nudged, { release: false });
    expect(chip()).toBeNull();
    expect(document.querySelector('[data-redocking]')).toBeNull();
    fireEvent.pointerUp(screen.getByTestId('agents-handle'), { pointerId: 7, ...nudged });

    expect(layoutBoxes()).toEqual(before);
  });

  test('Escape during a drag puts everything back and the release changes nothing', () => {
    render(<RedockHarness />);
    const before = layoutBoxes();
    const editor = box('editor');
    const target = { clientX: editor.start + 10, clientY: editor.top + 100 };

    dragHeader('agents', target, { release: false });
    expect(chip()).not.toBeNull();
    expect(fireEvent.keyDown(window, { key: 'Escape' })).toBe(false);
    expect(chip()).toBeNull();
    expect(dropZone()).toBeNull();
    expect(document.querySelector('[data-redocking]')).toBeNull();
    fireEvent.pointerUp(screen.getByTestId('agents-handle'), { pointerId: 7, ...target });

    expect(layoutBoxes()).toEqual(before);
  });

  test('a press whose release is lost to a context menu ends there, and a later release changes nothing', () => {
    render(<RedockHarness />);
    const before = layoutBoxes();
    const agents = box('agents');
    const editor = box('editor');
    const handle = screen.getByTestId('agents-handle');
    const target = { clientX: editor.start + 10, clientY: editor.top + editor.height / 2 };
    fireEvent.pointerDown(handle, {
      button: 0,
      buttons: 1,
      pointerId: 7,
      clientX: agents.start + 20,
      clientY: agents.top + 10,
    });
    fireEvent.contextMenu(handle);
    fireEvent.pointerMove(handle, { buttons: 1, pointerId: 7, ...target });
    expect(chip()).toBeNull();
    fireEvent.pointerUp(handle, { pointerId: 7, ...target });

    expect(layoutBoxes()).toEqual(before);
  });

  test('a move that arrives with the button already up ends the drag without a drop', () => {
    render(<RedockHarness />);
    const before = layoutBoxes();
    const editor = box('editor');
    const target = { clientX: editor.start + 10, clientY: editor.top + editor.height / 2 };

    dragHeader('agents', target, { release: false });
    expect(chip()).not.toBeNull();
    fireEvent.pointerMove(window, { buttons: 0, pointerId: 7, ...target });
    expect(chip()).toBeNull();
    expect(dropZone()).toBeNull();
    fireEvent.pointerUp(window, { pointerId: 7, ...target });

    expect(layoutBoxes()).toEqual(before);
  });

  test('with one unit showing, a header drag finds nowhere to go and starts nothing', () => {
    render(<RedockHarness visible={{ editor: true, agents: false, terminal: false }} />);
    const editor = box('editor');

    dragHeader(
      'editor',
      { clientX: editor.start + 300, clientY: editor.top + 300 },
      { release: false },
    );

    expect(chip()).toBeNull();
    expect(dropZone()).toBeNull();
  });

  test('right to left, a drop near the physical left of the editor docks at its end', () => {
    direction = 'rtl';
    render(<RedockHarness />);
    const editor = box('editor');
    const physicalLeft = WIDTH - (editor.start + editor.width);
    const target = { clientX: physicalLeft + 10, clientY: editor.top + editor.height / 2 };

    dragHeader('terminal', target, { release: false });
    expect(dropZone()?.dataset).toMatchObject({ dockDropZone: 'end', dockDropPane: 'editor' });
    fireEvent.pointerUp(screen.getByTestId('terminal-handle'), { pointerId: 7, ...target });

    expect(box('terminal').start).toBeGreaterThan(box('editor').start);
    expect(box('terminal').top).toBe(box('editor').top);
  });
});

function layoutBoxes() {
  return { editor: box('editor'), agents: box('agents'), terminal: box('terminal') };
}
