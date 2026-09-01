import type { TerminalCli } from '@inkeep/open-knowledge-core';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { OkDesktopBridge, OkMenuAction } from '@/lib/desktop-bridge-types';
import {
  __resetLocalMenuActionBusForTests,
  emitLocalMenuAction,
} from '@/lib/local-menu-action-bus';
import { writePreferBareTerminal } from '@/lib/terminal-new-tab-store';
import { saveStickyAgent, terminalCliId } from '@/lib/unified-agent-store';
import { requestPreferredSession } from './handoff/preferred-session-events';
import { requestActiveTerminalInput } from './handoff/terminal-input-events';
import { subscribeToTerminalLaunchRequests } from './handoff/terminal-launch-events';

const TERMINAL_PANEL_ID = 'terminal-dock-panel';

// biome-ignore lint/suspicious/noExplicitAny: captured mock-component props, asserted structurally
let terminalPanelProps: Record<string, any> | null = null;

const panelHandle = {
  collapse: vi.fn(() => terminalPanelProps?.onResize?.({ asPercentage: 0, inPixels: 0 })),
  expand: vi.fn(() => terminalPanelProps?.onResize?.({ asPercentage: 40, inPixels: 240 })),
  resize: vi.fn((s: string) => {
    const px = Number.parseInt(s, 10) || 0;
    terminalPanelProps?.onResize?.({ asPercentage: px > 0 ? 30 : 0, inPixels: px });
  }),
};
const sharedPanelRef: { current: unknown } = { current: panelHandle };

vi.doMock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined, isLoading: false, isError: false }),
}));

vi.doMock('react-resizable-panels', () => ({
  usePanelRef: () => sharedPanelRef,
}));

vi.doMock('@/components/ui/resizable', () => ({
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  ResizablePanelGroup: ({ children, orientation }: any) => (
    <div data-testid="rrp-group" data-orientation={orientation}>
      {children}
    </div>
  ),
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  ResizablePanel: (props: any) => {
    if (props.id === TERMINAL_PANEL_ID) terminalPanelProps = props;
    return (
      <div
        id={props.id}
        data-panel={props.id ?? 'editor'}
        data-inert={props.inert ? 'true' : undefined}
      >
        {props.children}
      </div>
    );
  },
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  ResizableHandle: ({ onPointerDown, disabled, withHandle }: any) => (
    <div
      data-testid="terminal-resize-handle"
      data-disabled={disabled ? 'true' : 'false'}
      data-with-handle={withHandle ? 'true' : 'false'}
      onPointerDown={onPointerDown}
    />
  ),
}));

const titleEmitters = new Map<string, (title: string) => void>();
function emitTitle(ptyId: string, title: string): boolean {
  const emit = titleEmitters.get(ptyId);
  if (emit == null) return false;
  emit(title);
  return true;
}

vi.doMock('./TerminalGate', () => ({
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  TerminalGate: ({ bridge, launch, onTitleChange, onPtyId }: any) => {
    const ptyIdRef = useRef<string | null>(null);
    const cancelledRef = useRef(false);
    const onTitleChangeRef = useRef(onTitleChange);
    const onPtyIdRef = useRef(onPtyId);
    useEffect(() => {
      onTitleChangeRef.current = onTitleChange;
      onPtyIdRef.current = onPtyId;
    });
    useEffect(() => {
      cancelledRef.current = false;
      void Promise.resolve(bridge?.terminal?.create?.({ cols: 80, rows: 24 })).then(
        (result: { ok?: boolean; ptyId?: string } | undefined) => {
          if (!result?.ok || result.ptyId == null) return;
          if (cancelledRef.current) bridge?.terminal?.kill?.(result.ptyId);
          else {
            ptyIdRef.current = result.ptyId;
            onPtyIdRef.current?.(result.ptyId);
            titleEmitters.set(result.ptyId, (title: string) => onTitleChangeRef.current?.(title));
          }
        },
      );
      return () => {
        cancelledRef.current = true;
        if (ptyIdRef.current != null) {
          onPtyIdRef.current?.(null);
          titleEmitters.delete(ptyIdRef.current);
          bridge?.terminal?.kill?.(ptyIdRef.current);
        }
      };
    }, [bridge]);
    return (
      <span
        data-testid="terminal-session"
        data-launch={launch?.nonce ?? 'none'}
        data-cli={launch?.cli ?? 'none'}
        className="xterm-helper-textarea"
        tabIndex={-1}
      />
    );
  },
}));

let mockInflightThreadLaunch = false;
vi.doMock('@/lib/acp/launch-agent-thread', () => ({
  launchAgentThread: () => Promise.resolve('started' as const),
  hasInflightThreadLaunch: () => mockInflightThreadLaunch,
}));

vi.doMock('@/lib/terminal-height-store', () => ({
  getInitialTerminalHeight: () => 240,
  writeTerminalHeight: () => {},
  clampTerminalHeight: (px: number) => px,
}));

const { TerminalDock, MAX_STRANDED_REPORTS } = await import('./TerminalDock');
const { SessionsHost } = await import('./SessionsHost');
const { STAGE_PASTE_SETTLE_MS } = await import('./TerminalPanel');

function makeBridge(platform: OkDesktopBridge['platform'] = 'darwin') {
  const viewMenuPushes: Array<{ terminalLive?: boolean }> = [];
  let ptyCounter = 0;
  const create = vi.fn(async () => {
    ptyCounter += 1;
    return { ok: true as const, ptyId: `pty-${ptyCounter}` };
  });
  const kill = vi.fn(async (_id: string) => {});
  const input = vi.fn((_ptyId: string, _data: string) => {});
  const bridge = {
    platform,
    onMenuAction: () => () => {},
    editor: {
      notifyViewMenuStateChanged(state: { terminalLive?: boolean }) {
        viewMenuPushes.push(state);
      },
    },
    terminal: { create, kill, input },
  } as unknown as OkDesktopBridge;
  return {
    bridge,
    create,
    kill,
    input,
    viewMenuPushes,
    dispatchMenuAction(action: OkMenuAction) {
      emitLocalMenuAction(action);
    },
  };
}

type TestLaunch = {
  prompt: string | null;
  nonce: number;
  cli?: TerminalCli;
  stagePaste?: string;
};

function DockHarness({
  v,
  l,
  p = 'bottom',
  targetAvailable = true,
  onVisibleChange,
  bridge,
  // biome-ignore lint/suspicious/noExplicitAny: test harness props
}: any) {
  const [bottomContainer, setBottomContainer] = useState<HTMLDivElement | null>(null);
  const [rightContainer, setRightContainer] = useState<HTMLDivElement | null>(null);
  const [editorRegionEl, setEditorRegionEl] = useState<HTMLDivElement | null>(null);
  return (
    <TooltipProvider>
      <TerminalDock
        placement={p}
        visible={v}
        onVisibleChange={onVisibleChange}
        onBottomContainer={setBottomContainer}
        onEditorRegion={setEditorRegionEl}
      >
        <div data-testid="editor-child" />
      </TerminalDock>
      {p === 'right' && targetAvailable ? (
        <div ref={setRightContainer} data-testid="terminal-right-mount" />
      ) : null}
      <SessionsHost
        surface="terminal-dock"
        terminalPlacement={p}
        bridge={bridge}
        terminalCapable
        visible={v}
        onVisibleChange={onVisibleChange}
        launch={l ?? null}
        container={p === 'right' ? rightContainer : bottomContainer}
        isShowing={v && (p === 'right' ? rightContainer != null : bottomContainer != null)}
        onRequestEditorFocus={() => editorRegionEl?.focus()}
      />
    </TooltipProvider>
  );
}

function renderDock(
  visible: boolean,
  launch?: TestLaunch | null,
  placement = 'bottom',
  platform: OkDesktopBridge['platform'] = 'darwin',
) {
  const onVisibleChange = vi.fn((_v: boolean) => {});
  const { bridge, create, kill, input, viewMenuPushes, dispatchMenuAction } = makeBridge(platform);
  const ui = (v: boolean, l?: TestLaunch | null, p = placement, targetAvailable = true) => (
    <DockHarness
      v={v}
      l={l ?? null}
      p={p}
      targetAvailable={targetAvailable}
      onVisibleChange={onVisibleChange}
      bridge={bridge}
    />
  );
  const utils = render(ui(visible, launch));
  return {
    ...utils,
    onVisibleChange,
    create,
    kill,
    input,
    viewMenuPushes,
    dispatchMenuAction,
    rerender: (v: boolean, l?: TestLaunch | null, p = placement, targetAvailable = true) =>
      utils.rerender(ui(v, l, p, targetAvailable)),
  };
}

function sessionPanels(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-terminal-session]'));
}

function activePanelId(): string | null {
  const active = document.querySelector<HTMLElement>(
    '[data-terminal-session][data-state="active"]',
  );
  return active?.getAttribute('data-terminal-session') ?? null;
}

function launchNonceOf(panelId: string | null): string | null {
  if (panelId === null) return null;
  return (
    document
      .querySelector(`[data-terminal-session="${panelId}"] [data-testid="terminal-session"]`)
      ?.getAttribute('data-launch') ?? null
  );
}

function editorRegion(): HTMLElement {
  const region = screen.getByTestId('editor-child').parentElement;
  if (region == null) throw new Error('editor region not found');
  return region;
}

async function addTerminalTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'New terminal' }));
}

describe('TerminalDock multi-session', () => {
  beforeEach(() => {
    localStorage.clear();
    terminalPanelProps = null;
    panelHandle.collapse.mockClear();
    panelHandle.resize.mockClear();
    panelHandle.expand.mockClear();
    sharedPanelRef.current = panelHandle;
    titleEmitters.clear();
    __resetLocalMenuActionBusForTests();
  });
  afterEach(() => {
    cleanup();
    __resetLocalMenuActionBusForTests();
  });

  test('moving the terminal reuses the live session subtree', async () => {
    const dock = renderDock(true);
    await waitFor(() => expect(dock.create).toHaveBeenCalledTimes(1));
    const session = screen.getByTestId('terminal-session');

    dock.rerender(true, null, 'right');

    await waitFor(() => {
      expect(screen.getByTestId('terminal-right-mount').contains(session)).toBe(true);
    });
    expect(screen.getByTestId('terminal-session')).toBe(session);
    expect(dock.create).toHaveBeenCalledTimes(1);
    expect(dock.kill).not.toHaveBeenCalled();
    expect(document.getElementById(TERMINAL_PANEL_ID)).toBeNull();

    dock.rerender(true, null, 'bottom');

    await waitFor(() => {
      expect(document.getElementById(TERMINAL_PANEL_ID)?.contains(session)).toBe(true);
    });
    expect(screen.getByTestId('terminal-session')).toBe(session);
    expect(screen.queryByTestId('terminal-right-mount')).toBeNull();
    expect(dock.create).toHaveBeenCalledTimes(1);
    expect(dock.kill).not.toHaveBeenCalled();
  });

  test('a transiently missing target retains the session until the rail attaches', async () => {
    const dock = renderDock(true);
    await waitFor(() => expect(dock.create).toHaveBeenCalledTimes(1));
    const session = screen.getByTestId('terminal-session');

    dock.rerender(true, null, 'right', false);

    expect(screen.queryByTestId('terminal-session')).toBeNull();
    expect(dock.create).toHaveBeenCalledTimes(1);
    expect(dock.kill).not.toHaveBeenCalled();

    dock.rerender(true, null, 'right');

    await waitFor(() => {
      expect(screen.getByTestId('terminal-right-mount').contains(session)).toBe(true);
    });
    expect(screen.getByTestId('terminal-session')).toBe(session);
    expect(dock.create).toHaveBeenCalledTimes(1);
    expect(dock.kill).not.toHaveBeenCalled();
  });

  test('rapid moves preserve tab order, active selection, and every session node', async () => {
    const user = userEvent.setup();
    const dock = renderDock(true);
    await waitFor(() => expect(dock.create).toHaveBeenCalledTimes(1));
    await addTerminalTab(user);
    await waitFor(() => expect(dock.create).toHaveBeenCalledTimes(2));
    const sessionNodes = screen.getAllByTestId('terminal-session');
    const orderedIds = sessionPanels().map((panel) => panel.dataset.terminalSession);
    const activeId = activePanelId();

    dock.rerender(true, null, 'right');
    dock.rerender(true, null, 'bottom');
    dock.rerender(true, null, 'right');

    expect(screen.getAllByTestId('terminal-session')).toEqual(sessionNodes);
    expect(sessionPanels().map((panel) => panel.dataset.terminalSession)).toEqual(orderedIds);
    expect(activePanelId()).toBe(activeId);
    expect(dock.create).toHaveBeenCalledTimes(2);
    expect(dock.kill).not.toHaveBeenCalled();
    expect(document.querySelectorAll('[data-terminal-session]')).toHaveLength(2);
    expect(document.getElementById(TERMINAL_PANEL_ID)).toBeNull();
    expect(
      screen.getByTestId('terminal-right-mount').querySelectorAll('[data-terminal-session]'),
    ).toHaveLength(2);
  });

  test('tab strip exposes the collapse button without obsolete dock or drag controls', () => {
    renderDock(true);
    expect(screen.getByRole('button', { name: 'Collapse Terminal' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Dock sessions/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Drag to dock the terminal' })).toBeNull();
  });

  test('mounts no session until first opened, then keeps the session mounted on hide', () => {
    const view = renderDock(false);
    expect(screen.queryAllByTestId('terminal-session')).toHaveLength(0);

    act(() => view.rerender(true));
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);

    act(() => view.rerender(false));
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
  });

  test('opening the dock creates a session and spawns its PTY', () => {
    const view = renderDock(false);
    expect(view.create).not.toHaveBeenCalled();

    act(() => view.rerender(true));

    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
    expect(view.create).toHaveBeenCalledTimes(1);
  });

  test('opening an empty dock launches the same preferred CLI as the New-session button', () => {
    writePreferBareTerminal(false);
    saveStickyAgent(terminalCliId('cursor'));
    const view = renderDock(false);

    act(() => view.rerender(true));

    expect(screen.getByTestId('terminal-session').getAttribute('data-cli')).toBe('cursor');
  });

  test('opening an empty dock launches a bare shell when Terminal is the pick', () => {
    writePreferBareTerminal(true);
    const view = renderDock(false);

    act(() => view.rerender(true));

    expect(screen.getByTestId('terminal-session').getAttribute('data-cli')).toBe('none');
  });

  test('opening an empty dock with NO pick launches a bare shell, not the first enabled CLI', () => {
    const view = renderDock(false);

    act(() => view.rerender(true));

    expect(screen.getByTestId('terminal-session').getAttribute('data-cli')).toBe('none');
  });

  test('a preferred-session shortcut launches the preferred CLI', () => {
    writePreferBareTerminal(false);
    saveStickyAgent(terminalCliId('cursor'));
    renderDock(true);

    act(() => requestPreferredSession());

    const sessions = screen.getAllByTestId('terminal-session');
    expect(sessions).toHaveLength(2);
    expect(sessions[1].getAttribute('data-cli')).toBe('cursor');
  });

  test('a preferred-session shortcut honors a bare-shell pick', () => {
    writePreferBareTerminal(true);
    renderDock(true);

    act(() => requestPreferredSession());

    const sessions = screen.getAllByTestId('terminal-session');
    expect(sessions).toHaveLength(2);
    expect(sessions[1].getAttribute('data-cli')).toBe('none');
  });

  test('the new-terminal control adds a session, activates it, and spawns its PTY', async () => {
    const user = userEvent.setup();
    const view = renderDock(true);
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
    const firstActive = activePanelId();

    await addTerminalTab(user);

    expect(screen.getAllByTestId('terminal-session')).toHaveLength(2);
    expect(activePanelId()).not.toBe(firstActive);
    expect(view.create).toHaveBeenCalledTimes(2);
  });

  test('all sessions stay mounted with exactly one active', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    await addTerminalTab(user);

    expect(screen.getAllByTestId('terminal-session')).toHaveLength(3);
    const tabpanels = screen.getAllByRole('tabpanel', { hidden: true });
    expect(tabpanels).toHaveLength(3);
    expect(document.querySelectorAll('[data-terminal-session][data-state="active"]')).toHaveLength(
      1,
    );
  });

  test('switching tabs changes the active session without unmounting the others', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    const secondActive = activePanelId();

    await user.click(screen.getByRole('tab', { name: 'Terminal 1' }));

    expect(activePanelId()).not.toBe(secondActive);
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(2);
  });

  test('typing target stays scoped: the active panel is the only one shown', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);

    expect(sessionPanels()).toHaveLength(2);
    const activeCount = document.querySelectorAll(
      '[data-terminal-session][data-state="active"]',
    ).length;
    expect(activeCount).toBe(1);
  });

  test('selecting a tab moves focus to that session', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    const second = activePanelId();

    await user.click(screen.getByRole('tab', { name: 'Terminal 1' }));
    const first = activePanelId();
    expect(first).not.toBe(second);

    const focusSink = document.querySelector<HTMLElement>(
      `[data-terminal-session="${first}"] .xterm-helper-textarea`,
    );
    expect(document.activeElement).toBe(focusSink);
  });

  test('closing a non-active tab removes only it and leaves the active one running', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    const activeBefore = activePanelId();

    await user.click(screen.getByRole('button', { name: 'Close Terminal 1' }));

    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
    expect(activePanelId()).toBe(activeBefore);
  });

  test("a session's OSC title becomes its tab label; siblings keep the default", async () => {
    const user = userEvent.setup();
    const view = renderDock(true);
    await addTerminalTab(user);
    await waitFor(() => expect(view.create).toHaveBeenCalledTimes(2));

    act(() => emitTitle('pty-1', 'claude — repo'));

    expect(screen.getByRole('tab', { name: 'claude — repo' })).toBeDefined();
    expect(screen.getByRole('tab', { name: 'Terminal 2' })).toBeDefined();
  });

  test('a later OSC title replaces an earlier one (live binding)', async () => {
    renderDock(true);
    await waitFor(() => expect(emitTitle('pty-1', 'first')).toBe(true));

    act(() => emitTitle('pty-1', 'first'));
    expect(screen.getByRole('tab', { name: 'first' })).toBeDefined();

    act(() => emitTitle('pty-1', 'second'));
    expect(screen.queryByRole('tab', { name: 'first' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'second' })).toBeDefined();
  });

  test('an empty OSC title reverts the tab to its positional default', async () => {
    renderDock(true);
    await waitFor(() => expect(emitTitle('pty-1', 'busy')).toBe(true));

    act(() => emitTitle('pty-1', 'busy'));
    expect(screen.getByRole('tab', { name: 'busy' })).toBeDefined();

    act(() => emitTitle('pty-1', ''));
    expect(screen.getByRole('tab', { name: 'Terminal 1' })).toBeDefined();
  });

  test('a whitespace-only OSC title reverts the tab to its positional default', async () => {
    renderDock(true);
    await waitFor(() => expect(emitTitle('pty-1', 'busy')).toBe(true));

    act(() => emitTitle('pty-1', 'busy'));
    expect(screen.getByRole('tab', { name: 'busy' })).toBeDefined();

    act(() => emitTitle('pty-1', '   '));
    expect(screen.getByRole('tab', { name: 'Terminal 1' })).toBeDefined();
  });

  test('a manual rename pins the tab label over later OSC title updates', async () => {
    const user = userEvent.setup();
    renderDock(true);

    await user.dblClick(screen.getByRole('tab', { name: 'Terminal 1' }));
    const input = screen.getByRole('textbox', { name: 'Rename Terminal 1' });
    await user.clear(input);
    await user.type(input, 'my shell');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('tab', { name: 'my shell' })).toBeDefined();

    await waitFor(() => expect(emitTitle('pty-1', 'claude — repo')).toBe(true));
    expect(screen.getByRole('tab', { name: 'my shell' })).toBeDefined();
    expect(screen.queryByRole('tab', { name: 'claude — repo' })).toBeNull();
  });

  test('clearing a custom label reverts the tab to the live OSC title', async () => {
    const user = userEvent.setup();
    renderDock(true);

    await waitFor(() => expect(emitTitle('pty-1', 'claude — repo')).toBe(true));
    expect(screen.getByRole('tab', { name: 'claude — repo' })).toBeDefined();

    await user.dblClick(screen.getByRole('tab', { name: 'claude — repo' }));
    await user.clear(screen.getByRole('textbox', { name: 'Rename claude — repo' }));
    await user.type(screen.getByRole('textbox', { name: 'Rename claude — repo' }), 'pinned');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('tab', { name: 'pinned' })).toBeDefined();

    await user.dblClick(screen.getByRole('tab', { name: 'pinned' }));
    await user.clear(screen.getByRole('textbox', { name: 'Rename pinned' }));
    await user.keyboard('{Enter}');
    expect(screen.getByRole('tab', { name: 'claude — repo' })).toBeDefined();
  });

  function tabLabels(): (string | null)[] {
    return within(screen.getByRole('tablist'))
      .getAllByRole('tab')
      .map((tab) => tab.textContent);
  }
  function dispatchChord(
    key: string,
    mods: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean },
  ): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
      key,
      ctrlKey: mods.ctrlKey ?? false,
      metaKey: mods.metaKey ?? false,
      shiftKey: mods.shiftKey ?? false,
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });
    return event;
  }

  test('⌘⇧← moves the active tab one slot left and announces the move', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    await addTerminalTab(user);
    const panels = sessionPanels();
    act(() => panels[2]?.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus());

    const event = dispatchChord('ArrowLeft', { metaKey: true, shiftKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(tabLabels()).toEqual(['Terminal 1', 'Terminal 3', 'Terminal 2']);
    await waitFor(() =>
      expect(screen.getByTestId('terminal-reorder-announcer').textContent).toBe(
        'Moved Terminal 3 to position 2 of 3',
      ),
    );
  });

  test('Ctrl+Shift+Left moves the active tab on Linux', async () => {
    const user = userEvent.setup();
    renderDock(true, null, 'bottom', 'linux');
    await addTerminalTab(user);
    const panels = sessionPanels();
    act(() => panels[1]?.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus());

    const event = dispatchChord('ArrowLeft', { ctrlKey: true, shiftKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(tabLabels()).toEqual(['Terminal 2', 'Terminal 1']);
  });

  test('⌘⇧→ at the last slot is a no-op left for the shell', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    const panels = sessionPanels();
    act(() => panels[1]?.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus());

    const event = dispatchChord('ArrowRight', { metaKey: true, shiftKey: true });

    expect(event.defaultPrevented).toBe(false);
    expect(tabLabels()).toEqual(['Terminal 1', 'Terminal 2']);
  });

  test('sticky numbering: closing a tab does not renumber the survivors', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    await addTerminalTab(user);
    expect(tabLabels()).toEqual(['Terminal 1', 'Terminal 2', 'Terminal 3']);

    await user.click(screen.getByRole('button', { name: 'Close Terminal 1' }));
    expect(tabLabels()).toEqual(['Terminal 2', 'Terminal 3']);

    await addTerminalTab(user);
    expect(tabLabels()).toEqual(['Terminal 2', 'Terminal 3', 'Terminal 4']);
  });

  test('⌘N targets the visual position after a keyboard reorder', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    const panels = sessionPanels();
    act(() => panels[1]?.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus());
    dispatchChord('ArrowLeft', { metaKey: true, shiftKey: true });
    expect(tabLabels()).toEqual(['Terminal 2', 'Terminal 1']);

    act(() =>
      document
        .querySelector<HTMLElement>(
          `[data-terminal-session="${activePanelId()}"] .xterm-helper-textarea`,
        )
        ?.focus(),
    );
    const jump = dispatchChord('1', { metaKey: true });
    expect(jump.defaultPrevented).toBe(true);
    expect(screen.getByRole('tab', { name: 'Terminal 2' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  test('Ctrl+1 selects the first terminal tab on Linux', async () => {
    const user = userEvent.setup();
    renderDock(true, null, 'bottom', 'linux');
    await addTerminalTab(user);
    const panels = sessionPanels();
    act(() => panels[1]?.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus());

    const event = dispatchChord('1', { ctrlKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByRole('tab', { name: 'Terminal 1' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  test('the reorder chord is left for native editing while a rename input is focused', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    await user.dblClick(screen.getByRole('tab', { name: 'Terminal 1' }));
    const input = screen.getByRole('textbox', { name: 'Rename Terminal 1' });

    const event = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      metaKey: true,
      shiftKey: true,
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      input.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(screen.getByRole('textbox', { name: 'Rename Terminal 1' })).toBeDefined();
  });

  test('reordering tabs does not move the session panels (live shells stay put)', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    await addTerminalTab(user);
    const panelIds = () => sessionPanels().map((el) => el.getAttribute('data-terminal-session'));
    const stableOrder = ['terminal-session-1', 'terminal-session-2', 'terminal-session-3'];
    expect(panelIds()).toEqual(stableOrder);

    act(() => sessionPanels()[2]?.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus());
    dispatchChord('ArrowLeft', { metaKey: true, shiftKey: true });

    expect(tabLabels()).toEqual(['Terminal 1', 'Terminal 3', 'Terminal 2']);
    expect(panelIds()).toEqual(stableOrder);
  });

  test("closing a tab reaps only that session's PTY and leaves the others alive", async () => {
    const user = userEvent.setup();
    const view = renderDock(true);
    await addTerminalTab(user);
    await waitFor(() => expect(view.create).toHaveBeenCalledTimes(2));
    expect(view.kill).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Close Terminal 1' }));

    await waitFor(() => expect(view.kill).toHaveBeenCalledWith('pty-1'));
    expect(view.kill).not.toHaveBeenCalledWith('pty-2');
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
  });

  test('closing the active tab activates its left neighbor', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    await addTerminalTab(user);
    await user.click(screen.getByRole('tab', { name: 'Terminal 2' }));
    const middle = activePanelId();

    await user.click(screen.getByRole('button', { name: 'Close Terminal 2' }));

    expect(screen.getAllByTestId('terminal-session')).toHaveLength(2);
    const nowActive = activePanelId();
    expect(nowActive).not.toBe(middle);
    expect(screen.getByRole('tab', { name: 'Terminal 1' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  test('closing the active leftmost tab activates its right neighbor', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    await user.click(screen.getByRole('tab', { name: 'Terminal 1' }));
    const closedId = activePanelId();
    const rightNeighborId =
      sessionPanels()
        .map((el) => el.getAttribute('data-terminal-session'))
        .find((id) => id !== closedId) ?? null;

    await user.click(screen.getByRole('button', { name: 'Close Terminal 1' }));

    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
    expect(activePanelId()).toBe(rightNeighborId);
  });

  test('closing the active tab moves focus into the surviving neighbor', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    await addTerminalTab(user);
    await user.click(screen.getByRole('tab', { name: 'Terminal 2' }));

    await user.click(screen.getByRole('button', { name: 'Close Terminal 2' }));

    const nowActive = activePanelId();
    const focusSink = document.querySelector<HTMLElement>(
      `[data-terminal-session="${nowActive}"] .xterm-helper-textarea`,
    );
    await waitFor(() => expect(document.activeElement).toBe(focusSink));
  });

  test('closing the last tab collapses the dock and returns focus to the editor', async () => {
    const user = userEvent.setup();
    const view = renderDock(true);
    act(() => screen.getByTestId('terminal-session').focus());

    await user.click(screen.getByRole('button', { name: 'Close Terminal 1' }));

    expect(screen.queryAllByTestId('terminal-session')).toHaveLength(0);
    expect(view.onVisibleChange).toHaveBeenCalledWith(false);
    expect(document.activeElement).toBe(editorRegion());
  });

  test('hiding the dock preserves every session and keeps the last-active tab on reopen', async () => {
    const user = userEvent.setup();
    const view = renderDock(true);
    await addTerminalTab(user);
    await addTerminalTab(user);
    await user.click(screen.getByRole('tab', { name: 'Terminal 2' }));
    const activeBeforeHide = activePanelId();
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(3);

    act(() => view.rerender(false));
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(3);
    expect(view.kill).not.toHaveBeenCalled();

    act(() => view.rerender(true));
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(3);
    expect(activePanelId()).toBe(activeBeforeHide);
    expect(screen.getByRole('tab', { name: 'Terminal 2' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  test('a launch intent opens a session carrying that intent', () => {
    const view = renderDock(false);
    expect(screen.queryAllByTestId('terminal-session')).toHaveLength(0);

    act(() => view.rerender(true, { prompt: 'work on docs', nonce: 7 }));

    const session = screen.getByTestId('terminal-session');
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
    expect(session.getAttribute('data-launch')).toBe('7');
  });

  test('cold-start with visible=true seeds exactly one session carrying the launch intent', () => {
    renderDock(true, { prompt: 'work on docs', nonce: 9 });
    const sessions = screen.getAllByTestId('terminal-session');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.getAttribute('data-launch')).toBe('9');
  });

  test('a launch always opens its own tab, even when a terminal is already live', async () => {
    const view = renderDock(true);
    await waitFor(() => expect(emitTitle('pty-1', 'zsh')).toBe(true));
    const runningId = activePanelId();
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);

    act(() => view.rerender(true, { prompt: 'work on docs', cli: 'claude', nonce: 1 }));

    const sessions = screen.getAllByTestId('terminal-session');
    expect(sessions).toHaveLength(2);
    const launchedId = activePanelId();
    expect(launchedId).not.toBe(runningId);
    expect(launchNonceOf(launchedId)).toBe('1');
    expect(view.input).not.toHaveBeenCalled();
  });

  test('the selection input reuses a live CLI tab — raw PTY write, no new tab', async () => {
    const view = renderDock(true);
    await waitFor(() => expect(emitTitle('pty-1', 'zsh')).toBe(true));
    act(() => view.rerender(true, { prompt: null, cli: 'claude', nonce: 1 }));
    await waitFor(() => expect(emitTitle('pty-2', 'claude')).toBe(true));
    const runningId = activePanelId();

    await act(async () => {
      requestActiveTerminalInput('explain this');
    });

    await waitFor(() => expect(view.input).toHaveBeenCalledWith('pty-2', 'explain this'));
    expect(activePanelId()).toBe(runningId);
  });

  test('a selection send into a bare shell is NEVER raw-written — it stages a fresh CLI instead', async () => {
    const view = renderDock(true);
    await waitFor(() => expect(emitTitle('pty-1', 'zsh')).toBe(true));
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);

    const launchRequests: Array<{ text: string; cli: string; stage: boolean }> = [];
    const stopLaunch = subscribeToTerminalLaunchRequests((text, cli, opts) =>
      launchRequests.push({ text, cli, stage: opts.stage }),
    );
    await act(async () => {
      requestActiveTerminalInput('explain this');
    });
    stopLaunch();

    expect(view.input).not.toHaveBeenCalled();
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
    expect(launchRequests).toEqual([{ text: 'explain this', cli: 'claude', stage: true }]);
  });

  test('a stagePaste launch opens its own tab; the HOST never types the passage (staging is TerminalPanel-owned, bake-gated)', async () => {
    const view = renderDock(false);
    act(() =>
      view.rerender(true, {
        prompt: null,
        cli: 'claude',
        nonce: 1,
        stagePaste: 'work on @notes.md — the selected passage',
      }),
    );

    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, STAGE_PASTE_SETTLE_MS + 200));
    expect(view.input).not.toHaveBeenCalled();
  });

  test('a launch before the seed terminal PTY is live also opens its own tab', () => {
    const view = renderDock(true);
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
    const seedId = activePanelId();

    act(() => view.rerender(true, { prompt: 'work on docs', cli: 'claude', nonce: 1 }));

    expect(screen.getAllByTestId('terminal-session')).toHaveLength(2);
    const launchedId = activePanelId();
    expect(launchedId).not.toBe(seedId);
    expect(launchNonceOf(launchedId)).toBe('1');
  });

  test('distinct launches each open their own tab', async () => {
    const view = renderDock(true);
    await waitFor(() => expect(emitTitle('pty-1', 'zsh')).toBe(true));

    act(() => view.rerender(true, { prompt: 'a', cli: 'claude', nonce: 1 }));
    act(() => view.rerender(true, { prompt: 'b', cli: 'claude', nonce: 2 }));

    expect(screen.getAllByTestId('terminal-session')).toHaveLength(3);
    expect(view.input).not.toHaveBeenCalled();
  });

  test('a repeated launch with the same nonce opens only one tab', async () => {
    const view = renderDock(true);
    await waitFor(() => expect(emitTitle('pty-1', 'zsh')).toBe(true));

    act(() => view.rerender(true, { prompt: 'a', cli: 'claude', nonce: 1 }));
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(2);

    act(() => view.rerender(true, { prompt: 'a', cli: 'claude', nonce: 1 }));
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(2);
  });

  test('the Terminal menu "New Terminal" action adds a tab and activates it', () => {
    const view = renderDock(true);
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
    const firstActive = activePanelId();

    act(() => view.dispatchMenuAction('new-terminal'));

    expect(screen.getAllByTestId('terminal-session')).toHaveLength(2);
    expect(activePanelId()).not.toBe(firstActive);
    expect(view.create).toHaveBeenCalledTimes(2);
  });

  test('the Terminal menu "Kill Terminal" action closes the active tab', async () => {
    const user = userEvent.setup();
    const view = renderDock(true);
    await addTerminalTab(user);
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(2);

    act(() => view.dispatchMenuAction('kill-terminal'));

    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
  });

  test('⌘W (close-active-tab-or-window) is NOT handled by the dock — the editor owns it', async () => {
    const user = userEvent.setup();
    const view = renderDock(true);
    await addTerminalTab(user);
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(2);

    act(() => view.dispatchMenuAction('close-active-tab-or-window'));

    expect(screen.getAllByTestId('terminal-session')).toHaveLength(2);
  });

  test('Cmd+number jumps to the matching tab while the terminal is focused', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    await addTerminalTab(user);
    const panels = sessionPanels();
    const thirdSink = panels[2]?.querySelector<HTMLElement>('.xterm-helper-textarea');
    act(() => thirdSink?.focus());
    expect(activePanelId()).toBe(panels[2]?.getAttribute('data-terminal-session'));

    const event = new KeyboardEvent('keydown', {
      key: '1',
      metaKey: true,
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByRole('tab', { name: 'Terminal 1' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(activePanelId()).toBe(panels[0]?.getAttribute('data-terminal-session'));
  });

  test('Cmd+number for a tab that does not exist is left for the shell', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    const panels = sessionPanels();
    act(() => panels[1]?.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus());
    const before = activePanelId();

    const event = new KeyboardEvent('keydown', {
      key: '5',
      metaKey: true,
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(activePanelId()).toBe(before);
  });

  test('Cmd+number is ignored when focus is outside the terminal dock', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    await user.click(screen.getByRole('tab', { name: 'Terminal 1' }));
    const before = activePanelId();

    act(() => editorRegion().focus());
    const event = new KeyboardEvent('keydown', {
      key: '2',
      metaKey: true,
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(activePanelId()).toBe(before);
  });

  test('a non-chord keystroke is not intercepted so it reaches the active shell', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    const before = activePanelId();
    act(() => sessionPanels()[0]?.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus());

    const escapeEvent = new KeyboardEvent('keydown', {
      key: 'Escape',
      cancelable: true,
      bubbles: true,
    });
    const digitEvent = new KeyboardEvent('keydown', {
      key: '1',
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      window.dispatchEvent(escapeEvent);
      window.dispatchEvent(digitEvent);
    });

    expect(escapeEvent.defaultPrevented).toBe(false);
    expect(digitEvent.defaultPrevented).toBe(false);
    expect(activePanelId()).toBe(before);
  });

  test('reports terminal liveness — true once a session exists, false after the last closes', async () => {
    const user = userEvent.setup();
    const view = renderDock(false);
    expect(view.viewMenuPushes.at(-1)).toEqual({ terminalLive: false });

    act(() => view.rerender(true));
    expect(view.viewMenuPushes.at(-1)).toEqual({ terminalLive: true });

    await user.click(screen.getByRole('button', { name: 'Close Terminal 1' }));
    expect(view.viewMenuPushes.at(-1)).toEqual({ terminalLive: false });
  });

  test('wires each tab to its panel via accessible tablist/tabpanel relationships', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);

    const tablist = screen.getByRole('tablist', { name: 'Terminal sessions' });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    for (const tab of tabs) {
      const panelId = tab.getAttribute('aria-controls');
      expect(panelId).toBeTruthy();
      expect(document.getElementById(panelId ?? '')).not.toBeNull();
    }
  });

  test('a pointercancel-terminated drag stops later resizes reading as user drags', () => {
    const view = renderDock(true);
    const handle = screen.getByTestId('terminal-resize-handle');
    act(() => {
      fireEvent.pointerDown(handle);
    });
    act(() => {
      fireEvent.pointerCancel(window);
    });
    view.onVisibleChange.mockClear();

    act(() => {
      terminalPanelProps?.onResize?.({ asPercentage: 0, inPixels: 0 });
    });
    expect(view.onVisibleChange).not.toHaveBeenCalled();
  });

  test('a different pointer cancelling does not end an in-flight dock drag', () => {
    const view = renderDock(true);
    const handle = screen.getByTestId('terminal-resize-handle');
    act(() => {
      fireEvent.pointerDown(handle, { pointerId: 1 });
    });

    act(() => {
      fireEvent.pointerCancel(window, { pointerId: 2 });
    });
    view.onVisibleChange.mockClear();
    act(() => {
      terminalPanelProps?.onResize?.({ asPercentage: 0, inPixels: 0 });
    });
    expect(view.onVisibleChange).toHaveBeenCalledWith(false);

    act(() => {
      fireEvent.pointerCancel(window, { pointerId: 1 });
    });
    view.onVisibleChange.mockClear();
    act(() => {
      terminalPanelProps?.onResize?.({ asPercentage: 0, inPixels: 0 });
    });
    expect(view.onVisibleChange).not.toHaveBeenCalled();
  });

  test('persists the bottom panel config (collapsible, sized, inert when hidden)', () => {
    renderDock(false);
    expect(terminalPanelProps?.collapsible).toBe(true);
    expect(terminalPanelProps?.collapsedSize).toBe(0);
    expect(terminalPanelProps?.minSize).toBe('120px');
    expect(terminalPanelProps?.maxSize).toBe('95%');
    expect(terminalPanelProps?.defaultSize).toBe(0);
    expect(terminalPanelProps?.inert).toBe(true);
  });

  test('focuses the active session on reveal so the user can type immediately', () => {
    const view = renderDock(true);
    const session = screen.getByTestId('terminal-session');

    act(() => view.rerender(false));
    expect(document.activeElement).toBe(editorRegion());

    act(() => view.rerender(true));
    expect(document.activeElement).toBe(session);
  });

  test('renders no edge reveal tab, hidden or visible', () => {
    const view = renderDock(false);
    expect(screen.queryByRole('button', { name: 'Open terminal' })).toBeNull();
    expect(editorRegion().querySelector('[data-terminal-reveal]')).toBeNull();

    act(() => view.rerender(true));
    expect(screen.queryByRole('button', { name: 'Open terminal' })).toBeNull();
  });

  test('disables the resize handle while hidden so there is no drag-to-open', () => {
    const view = renderDock(false);
    expect(screen.getByTestId('terminal-resize-handle').getAttribute('data-disabled')).toBe('true');

    act(() => view.rerender(true));
    expect(screen.getByTestId('terminal-resize-handle').getAttribute('data-disabled')).toBe(
      'false',
    );
  });
});

describe('TerminalDock extraction pins', () => {
  beforeEach(() => {
    terminalPanelProps = null;
    panelHandle.collapse.mockClear();
    panelHandle.resize.mockClear();
    panelHandle.expand.mockClear();
    sharedPanelRef.current = panelHandle;
  });
  afterEach(() => {
    cleanup();
  });

  test('pin: closing the last tab collapses the dock and returns focus to the editor', async () => {
    const user = userEvent.setup();
    const view = renderDock(true);
    act(() => screen.getByTestId('terminal-session').focus());

    await user.click(screen.getByRole('button', { name: 'Close Terminal 1' }));

    expect(screen.queryAllByTestId('terminal-session')).toHaveLength(0);
    expect(view.onVisibleChange).toHaveBeenCalledWith(false);
    expect(document.activeElement).toBe(editorRegion());
  });

  test('pin: the dock seeds exactly one session when it becomes visible', () => {
    const view = renderDock(false);
    expect(screen.queryAllByTestId('terminal-session')).toHaveLength(0);

    act(() => view.rerender(true));

    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
    expect(view.create).toHaveBeenCalledTimes(1);
  });

  test('pin: an in-flight AGENT-thread launch does not swallow the dock shell', () => {
    mockInflightThreadLaunch = true;
    try {
      const view = renderDock(false);
      expect(screen.queryAllByTestId('terminal-session')).toHaveLength(0);

      act(() => view.rerender(true));

      expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
      expect(view.create).toHaveBeenCalledTimes(1);
    } finally {
      mockInflightThreadLaunch = false;
    }
  });

  test('pin: a repeated launch nonce does not open a second tab', () => {
    const view = renderDock(true);

    act(() => view.rerender(true, { prompt: 'work', nonce: 1 }));
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(2);

    act(() => view.rerender(true, { prompt: 'work', nonce: 1 }));
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(2);
  });

  test('pin: Cmd+number switches the active tab while the terminal is focused', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    const panels = sessionPanels();
    act(() => panels[1]?.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus());

    const event = new KeyboardEvent('keydown', {
      key: '1',
      metaKey: true,
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(activePanelId()).toBe(panels[0]?.getAttribute('data-terminal-session'));
  });

  test('pin: closing the active tab moves focus to a surviving neighbor', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await addTerminalTab(user);
    await addTerminalTab(user);
    await user.click(screen.getByRole('tab', { name: 'Terminal 2' }));

    await user.click(screen.getByRole('button', { name: 'Close Terminal 2' }));

    const nowActive = activePanelId();
    const focusSink = document.querySelector<HTMLElement>(
      `[data-terminal-session="${nowActive}"] .xterm-helper-textarea`,
    );
    await waitFor(() => expect(document.activeElement).toBe(focusSink));
  });
});

describe('TerminalDock hidden-dock invariant', () => {
  beforeEach(() => {
    localStorage.clear();
    terminalPanelProps = null;
    panelHandle.collapse.mockClear();
    panelHandle.resize.mockClear();
    panelHandle.expand.mockClear();
    sharedPanelRef.current = panelHandle;
    __resetLocalMenuActionBusForTests();
  });
  afterEach(() => {
    cleanup();
    __resetLocalMenuActionBusForTests();
  });

  function reportSize(inPixels: number, asPercentage: number) {
    act(() => {
      terminalPanelProps?.onResize?.({ asPercentage, inPixels });
    });
  }

  function strandedLogs(warn: ReturnType<typeof vi.spyOn>): string[] {
    return warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('ok-terminal-dock-stranded-while-hidden'));
  }

  test('a hidden dock that reports a non-zero height is snapped shut', () => {
    renderDock(false);
    panelHandle.collapse.mockClear();

    reportSize(588, 42.5);

    expect(panelHandle.collapse).toHaveBeenCalled();
  });

  test('an unmeasurable group (NaN percentage, zero pixels) is left alone', () => {
    renderDock(false);
    panelHandle.collapse.mockClear();

    reportSize(0, Number.NaN);

    expect(panelHandle.collapse).not.toHaveBeenCalled();
  });

  test('an open dock keeps the height it reports', () => {
    renderDock(true);
    panelHandle.collapse.mockClear();

    reportSize(240, 30);

    expect(panelHandle.collapse).not.toHaveBeenCalled();
  });

  test('the repair is reported with the geometry needed to diagnose it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      renderDock(false);
      reportSize(588, 42.5);

      const [line] = strandedLogs(warn);
      expect(line).toBeDefined();
      expect(JSON.parse(line as string)).toMatchObject({
        event: 'ok-terminal-dock-stranded-while-hidden',
        panelPx: 588,
        panelPct: 42.5,
        visible: false,
      });
      const payload = JSON.parse(line as string);
      expect(typeof payload.innerHeight).toBe('number');
      expect(typeof payload.dockHeightPx).toBe('number');
    } finally {
      warn.mockRestore();
    }
  });

  test('the report is capped so a fight with another layout writer cannot flood the log', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      renderDock(false);
      for (let i = 0; i < MAX_STRANDED_REPORTS + 4; i++) reportSize(588, 42.5);

      expect(strandedLogs(warn)).toHaveLength(MAX_STRANDED_REPORTS);
    } finally {
      warn.mockRestore();
    }
  });
});
