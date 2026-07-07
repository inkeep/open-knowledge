/**
 * Behavioral tests for the standalone terminal window surface + the renderer
 * mode routing that selects it.
 *
 * TerminalGate (the heavy consent + xterm session) is stubbed with a session
 * stand-in that spawns a PTY on mount and reaps it on unmount — the same
 * pattern as TerminalDock.dom.test.tsx — so the assertions pin what the window
 * owns: one shell on mount, the new-tab affordance, ⌘1–9 switching with no
 * scope gate, and close-last → window.close(). The window mounts the shared
 * TerminalSessionsHost (window variant), so the session model — including the
 * New-chat split button — is the dock's. The sibling root surfaces are
 * stubbed so the routing helper resolves without pulling the editor / navigator
 * trees.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useRef } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

mock.module('./TerminalGate', () => ({
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  TerminalGate: ({ bridge }: any) => {
    const ptyIdRef = useRef<string | null>(null);
    const cancelledRef = useRef(false);
    useEffect(() => {
      cancelledRef.current = false;
      void Promise.resolve(bridge?.terminal?.create?.({ cols: 80, rows: 24 })).then(
        (result: { ok?: boolean; ptyId?: string } | undefined) => {
          if (!result?.ok || result.ptyId == null) return;
          if (cancelledRef.current) bridge?.terminal?.kill?.(result.ptyId);
          else ptyIdRef.current = result.ptyId;
        },
      );
      return () => {
        cancelledRef.current = true;
        if (ptyIdRef.current != null) bridge?.terminal?.kill?.(ptyIdRef.current);
      };
    }, [bridge]);
    return <span data-testid="terminal-session" className="xterm-helper-textarea" tabIndex={-1} />;
  },
}));

mock.module('@/App', () => ({ App: () => <div data-testid="editor-app" /> }));
mock.module('@/components/NavigatorApp', () => ({
  NavigatorApp: () => <div data-testid="navigator-app" />,
}));

const { TerminalWindowApp } = await import('./TerminalWindowApp');
const { selectDesktopRootApp } = await import('./desktop-root-app');

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
    config: { mode: 'terminal' },
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

function bridgeWithMode(mode: string): OkDesktopBridge {
  return { config: { mode } } as unknown as OkDesktopBridge;
}

// Adds a plain-shell tab via the New-chat split button's "Terminal" option —
// the same affordance the dock has (the window holds feature parity; only the
// placement differs).
async function addTerminalTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Choose CLI for new chat' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Terminal' }));
}

function sessionPanels(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-terminal-session]'));
}

function activePanelId(): string | null {
  return (
    document
      .querySelector<HTMLElement>('[data-terminal-session][data-state="active"]')
      ?.getAttribute('data-terminal-session') ?? null
  );
}

describe('TerminalWindowApp', () => {
  afterEach(() => {
    cleanup();
  });

  test('opens with exactly one shell tab on mount', () => {
    const { bridge, create } = makeBridge();
    render(
      <TooltipProvider>
        <TerminalWindowApp bridge={bridge} />
      </TooltipProvider>,
    );
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('the new-chat control opens an additional independent tab', async () => {
    const user = userEvent.setup();
    const { bridge, create } = makeBridge();
    render(
      <TooltipProvider>
        <TerminalWindowApp bridge={bridge} />
      </TooltipProvider>,
    );

    await addTerminalTab(user);

    expect(screen.getAllByTestId('terminal-session')).toHaveLength(2);
    expect(create).toHaveBeenCalledTimes(2);
  });

  test('Cmd+number switches tabs with no focus-scope gate (the whole window is the terminal)', async () => {
    const user = userEvent.setup();
    const { bridge } = makeBridge();
    render(
      <TooltipProvider>
        <TerminalWindowApp bridge={bridge} />
      </TooltipProvider>,
    );
    await addTerminalTab(user);
    // Deliberately do NOT focus inside a terminal panel: unlike the dock, the
    // window has no scope gate, so the chord works regardless of focus.
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
    expect(activePanelId()).toBe(sessionPanels()[0]?.getAttribute('data-terminal-session'));
  });

  test('Cmd+number with a co-modifier (Ctrl) falls through to the shell, not a tab switch', async () => {
    const user = userEvent.setup();
    const { bridge } = makeBridge();
    render(
      <TooltipProvider>
        <TerminalWindowApp bridge={bridge} />
      </TooltipProvider>,
    );
    await addTerminalTab(user);
    const activeBefore = activePanelId();

    // Ctrl+Cmd+1 (and other co-modified chords) belong to the running program,
    // not the tab strip — the switch handler must ignore them entirely so the
    // keystroke reaches the shell.
    const event = new KeyboardEvent('keydown', {
      key: '1',
      metaKey: true,
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(activePanelId()).toBe(activeBefore);
  });

  test('closing the last tab closes the window instead of leaving an empty surface', async () => {
    const user = userEvent.setup();
    const closeSpy = spyOn(window, 'close').mockImplementation(() => {});
    try {
      const { bridge } = makeBridge();
      render(
        <TooltipProvider>
          <TerminalWindowApp bridge={bridge} />
        </TooltipProvider>,
      );
      expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);

      await user.click(screen.getByRole('button', { name: 'Close Terminal 1' }));

      expect(screen.queryAllByTestId('terminal-session')).toHaveLength(0);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      closeSpy.mockRestore();
    }
  });

  test('the Terminal menu "New Terminal" action opens an additional tab in the focused window', () => {
    const view = makeBridge();
    render(
      <TooltipProvider>
        <TerminalWindowApp bridge={view.bridge} />
      </TooltipProvider>,
    );
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);

    act(() => view.dispatchMenuAction('new-terminal'));

    // The window handles the menu action itself — without the onMenuAction
    // wiring the action is delivered to a renderer with no listener and is inert.
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(2);
    expect(view.create).toHaveBeenCalledTimes(2);
  });

  test('the Terminal menu "Kill Terminal" action closes the active tab in the focused window', async () => {
    const user = userEvent.setup();
    const view = makeBridge();
    render(
      <TooltipProvider>
        <TerminalWindowApp bridge={view.bridge} />
      </TooltipProvider>,
    );
    await addTerminalTab(user);
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(2);

    act(() => view.dispatchMenuAction('kill-terminal'));

    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
  });

  test('⌘W (close-active-tab-or-window) closes the active tab; the last tab closes the window', async () => {
    const user = userEvent.setup();
    const closeSpy = spyOn(window, 'close').mockImplementation(() => {});
    try {
      const view = makeBridge();
      render(
        <TooltipProvider>
          <TerminalWindowApp bridge={view.bridge} />
        </TooltipProvider>,
      );
      await addTerminalTab(user);
      expect(screen.getAllByTestId('terminal-session')).toHaveLength(2);

      // ⌘W closes the innermost unit first: the active tab.
      act(() => view.dispatchMenuAction('close-active-tab-or-window'));
      expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
      expect(closeSpy).not.toHaveBeenCalled();

      // With one tab left, ⌘W cascades to closing the window itself.
      act(() => view.dispatchMenuAction('close-active-tab-or-window'));
      expect(screen.queryAllByTestId('terminal-session')).toHaveLength(0);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      closeSpy.mockRestore();
    }
  });

  test('reports terminal liveness to main so "Kill Terminal" enables while the window is focused', () => {
    const view = makeBridge();
    render(
      <TooltipProvider>
        <TerminalWindowApp bridge={view.bridge} />
      </TooltipProvider>,
    );
    // The window opens with one shell, so the menu must read its liveness from
    // the focused window rather than a stale editor-dock singleton.
    expect(view.viewMenuPushes.at(-1)).toEqual({ terminalLive: true });
  });
});

describe('selectDesktopRootApp routing', () => {
  beforeEach(() => {
    cleanup();
  });
  afterEach(() => {
    cleanup();
  });

  test('mode=terminal selects the terminal window app', () => {
    expect(selectDesktopRootApp(bridgeWithMode('terminal')).type).toBe(TerminalWindowApp);
  });

  test('mounting the terminal-mode selection renders the full-window terminal', () => {
    const { bridge } = makeBridge();
    render(<TooltipProvider>{selectDesktopRootApp(bridge)}</TooltipProvider>);
    expect(screen.getByRole('tablist', { name: 'Terminal sessions' })).toBeTruthy();
    expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
  });

  test('mode=navigator does not select the terminal window app', () => {
    expect(selectDesktopRootApp(bridgeWithMode('navigator')).type).not.toBe(TerminalWindowApp);
  });

  test('mode=editor does not select the terminal window app', () => {
    expect(selectDesktopRootApp(bridgeWithMode('editor')).type).not.toBe(TerminalWindowApp);
  });

  test('no bridge (web / CLI) does not select the terminal window app', () => {
    expect(selectDesktopRootApp(undefined).type).not.toBe(TerminalWindowApp);
  });
});
