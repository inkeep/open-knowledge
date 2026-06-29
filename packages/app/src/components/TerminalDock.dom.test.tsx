import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useRef } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

const TERMINAL_PANEL_ID = 'terminal-dock-panel';

// biome-ignore lint/suspicious/noExplicitAny: captured mock-component props, asserted structurally
let terminalPanelProps: Record<string, any> | null = null;

const panelHandle = {
  collapse: mock(() => terminalPanelProps?.onResize?.({ asPercentage: 0, inPixels: 0 })),
  expand: mock(() => terminalPanelProps?.onResize?.({ asPercentage: 40, inPixels: 240 })),
  resize: mock((s: string) => {
    const px = Number.parseInt(s, 10) || 0;
    terminalPanelProps?.onResize?.({ asPercentage: px > 0 ? 30 : 0, inPixels: px });
  }),
};
const sharedPanelRef: { current: unknown } = { current: panelHandle };

mock.module('react-resizable-panels', () => ({
  usePanelRef: () => sharedPanelRef,
}));

mock.module('@/components/ui/resizable', () => ({
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
  ResizableHandle: ({ onPointerDown }: any) => (
    <div data-testid="terminal-resize-handle" onPointerDown={onPointerDown} />
  ),
}));

const titleEmitters = new Map<string, (title: string) => void>();
function emitTitle(ptyId: string, title: string): boolean {
  const emit = titleEmitters.get(ptyId);
  if (emit == null) return false;
  emit(title);
  return true;
}

mock.module('./TerminalGate', () => ({
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  TerminalGate: ({ bridge, launch, onTitleChange }: any) => {
    const ptyIdRef = useRef<string | null>(null);
    const cancelledRef = useRef(false);
    const onTitleChangeRef = useRef(onTitleChange);
    useEffect(() => {
      onTitleChangeRef.current = onTitleChange;
    });
    useEffect(() => {
      cancelledRef.current = false;
      void Promise.resolve(bridge?.terminal?.create?.({ cols: 80, rows: 24 })).then(
        (result: { ok?: boolean; ptyId?: string } | undefined) => {
          if (!result?.ok || result.ptyId == null) return;
          if (cancelledRef.current) bridge?.terminal?.kill?.(result.ptyId);
          else {
            ptyIdRef.current = result.ptyId;
            titleEmitters.set(result.ptyId, (title: string) => onTitleChangeRef.current?.(title));
          }
        },
      );
      return () => {
        cancelledRef.current = true;
        if (ptyIdRef.current != null) {
          titleEmitters.delete(ptyIdRef.current);
          bridge?.terminal?.kill?.(ptyIdRef.current);
        }
      };
    }, [bridge]);
    return (
      <span
        data-testid="terminal-session"
        data-launch={launch?.nonce ?? 'none'}
        className="xterm-helper-textarea"
        tabIndex={-1}
      />
    );
  },
}));

mock.module('@/lib/terminal-height-store', () => ({
  getInitialTerminalHeight: () => 240,
  writeTerminalHeight: () => {},
}));

const { TerminalDock } = await import('./TerminalDock');

function makeBridge() {
  const menuHandlers: Array<(action: string) => void> = [];
  const viewMenuPushes: Array<{ terminalLive?: boolean }> = [];
  let ptyCounter = 0;
  const create = mock(async () => {
    ptyCounter += 1;
    return { ok: true as const, ptyId: `pty-${ptyCounter}` };
  });
  const kill = mock(async (_id: string) => {});
  const bridge = {
    onMenuAction(cb: (action: string) => void) {
      menuHandlers.push(cb);
      return () => {
        const index = menuHandlers.indexOf(cb);
        if (index >= 0) menuHandlers.splice(index, 1);
      };
    },
    editor: {
      notifyViewMenuStateChanged(state: { terminalLive?: boolean }) {
        viewMenuPushes.push(state);
      },
    },
    terminal: { create, kill },
  } as unknown as OkDesktopBridge;
  return {
    bridge,
    create,
    kill,
    viewMenuPushes,
    dispatchMenuAction(action: string) {
      for (const cb of menuHandlers) cb(action);
    },
  };
}

function renderDock(visible: boolean, launch?: { prompt: string; nonce: number } | null) {
  const onVisibleChange = mock((_v: boolean) => {});
  const { bridge, create, kill, viewMenuPushes, dispatchMenuAction } = makeBridge();
  const ui = (v: boolean, l?: { prompt: string; nonce: number } | null) => (
    <TooltipProvider>
      <TerminalDock
        bridge={bridge}
        visible={v}
        onVisibleChange={onVisibleChange}
        launch={l ?? null}
      >
        <div data-testid="editor-child" />
      </TerminalDock>
    </TooltipProvider>
  );
  const utils = render(ui(visible, launch));
  return {
    ...utils,
    onVisibleChange,
    create,
    kill,
    viewMenuPushes,
    dispatchMenuAction,
    rerender: (v: boolean, l?: { prompt: string; nonce: number } | null) =>
      utils.rerender(ui(v, l)),
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

describe('TerminalDock multi-session', () => {
  beforeEach(() => {
    terminalPanelProps = null;
    panelHandle.collapse.mockClear();
    panelHandle.resize.mockClear();
    panelHandle.expand.mockClear();
    sharedPanelRef.current = panelHandle;
    titleEmitters.clear();
  });
  afterEach(() => {
    cleanup();
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

  test('the new-terminal control adds a session, activates it, and spawns its PTY', async () => {
    const user = userEvent.setup();
    const view = renderDock(true);
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
    const firstActive = activePanelId();

    await user.click(screen.getByRole('button', { name: 'New terminal' }));

    expect(screen.getAllByTestId('terminal-session')).toHaveLength(2);
    expect(activePanelId()).not.toBe(firstActive);
    expect(view.create).toHaveBeenCalledTimes(2);
  });

  test('all sessions stay mounted with exactly one active', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await user.click(screen.getByRole('button', { name: 'New terminal' }));
    await user.click(screen.getByRole('button', { name: 'New terminal' }));

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
    await user.click(screen.getByRole('button', { name: 'New terminal' }));
    const secondActive = activePanelId();

    await user.click(screen.getByRole('tab', { name: 'Terminal 1' }));

    expect(activePanelId()).not.toBe(secondActive);
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(2);
  });

  test('typing target stays scoped: the active panel is the only one shown', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await user.click(screen.getByRole('button', { name: 'New terminal' }));

    expect(sessionPanels()).toHaveLength(2);
    const activeCount = document.querySelectorAll(
      '[data-terminal-session][data-state="active"]',
    ).length;
    expect(activeCount).toBe(1);
  });

  test('selecting a tab moves focus to that session', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await user.click(screen.getByRole('button', { name: 'New terminal' }));
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
    await user.click(screen.getByRole('button', { name: 'New terminal' }));
    const activeBefore = activePanelId();

    await user.click(screen.getByRole('button', { name: 'Close Terminal 1' }));

    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
    expect(activePanelId()).toBe(activeBefore);
  });

  test("a session's OSC title becomes its tab label; siblings keep the default", async () => {
    const user = userEvent.setup();
    const view = renderDock(true);
    await user.click(screen.getByRole('button', { name: 'New terminal' }));
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

  test("closing a tab reaps only that session's PTY and leaves the others alive", async () => {
    const user = userEvent.setup();
    const view = renderDock(true);
    await user.click(screen.getByRole('button', { name: 'New terminal' }));
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
    await user.click(screen.getByRole('button', { name: 'New terminal' }));
    await user.click(screen.getByRole('button', { name: 'New terminal' }));
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
    await user.click(screen.getByRole('button', { name: 'New terminal' }));
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
    await user.click(screen.getByRole('button', { name: 'New terminal' }));
    await user.click(screen.getByRole('button', { name: 'New terminal' }));
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
    await user.click(screen.getByRole('button', { name: 'New terminal' }));
    await user.click(screen.getByRole('button', { name: 'New terminal' }));
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

  test('a launch while a tab is running opens a NEW tab and leaves the running one untouched', () => {
    const view = renderDock(true);
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
    const runningId = activePanelId();
    expect(launchNonceOf(runningId)).toBe('none');

    act(() => view.rerender(true, { prompt: 'work on docs', nonce: 1 }));

    expect(screen.getAllByTestId('terminal-session')).toHaveLength(2);
    const launchedId = activePanelId();
    expect(launchedId).not.toBe(runningId);
    expect(launchNonceOf(launchedId)).toBe('1');
    expect(launchNonceOf(runningId)).toBe('none');
  });

  test('distinct launch nonces each open their own tab', () => {
    const view = renderDock(true);

    act(() => view.rerender(true, { prompt: 'a', nonce: 1 }));
    act(() => view.rerender(true, { prompt: 'b', nonce: 2 }));

    expect(screen.getAllByTestId('terminal-session')).toHaveLength(3);
  });

  test('a repeated launch with the same nonce does not open a second tab', () => {
    const view = renderDock(true);

    act(() => view.rerender(true, { prompt: 'a', nonce: 1 }));
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(2);

    act(() => view.rerender(true, { prompt: 'a', nonce: 1 }));
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
    await user.click(screen.getByRole('button', { name: 'New terminal' }));
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(2);

    act(() => view.dispatchMenuAction('kill-terminal'));

    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
  });

  test('Cmd+number jumps to the matching tab while the terminal is focused', async () => {
    const user = userEvent.setup();
    renderDock(true);
    await user.click(screen.getByRole('button', { name: 'New terminal' }));
    await user.click(screen.getByRole('button', { name: 'New terminal' }));
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
    await user.click(screen.getByRole('button', { name: 'New terminal' }));
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
    await user.click(screen.getByRole('button', { name: 'New terminal' }));
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
    await user.click(screen.getByRole('button', { name: 'New terminal' }));
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
    await user.click(screen.getByRole('button', { name: 'New terminal' }));

    const tablist = screen.getByRole('tablist', { name: 'Terminal sessions' });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    for (const tab of tabs) {
      const panelId = tab.getAttribute('aria-controls');
      expect(panelId).toBeTruthy();
      expect(document.getElementById(panelId ?? '')).not.toBeNull();
    }
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
});
