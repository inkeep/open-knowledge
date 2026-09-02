import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { OkDesktopBridge, OkMenuAction } from '@/lib/desktop-bridge-types';
import {
  __resetLocalMenuActionBusForTests,
  emitLocalMenuAction,
} from '@/lib/local-menu-action-bus';

vi.doMock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined, isLoading: false, isError: false }),
}));

vi.doMock('./TerminalGate', () => ({
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

vi.doMock('@/App', () => ({ App: () => <div data-testid="editor-app" /> }));
vi.doMock('@/components/NavigatorApp', () => ({
  NavigatorApp: () => <div data-testid="navigator-app" />,
}));

const { TerminalWindowApp } = await import('./TerminalWindowApp');
const { selectDesktopRootApp } = await import('./desktop-root-app');

function makeBridge(platform: OkDesktopBridge['platform'] = 'darwin') {
  const viewMenuPushes: Array<{ terminalLive?: boolean }> = [];
  let ptyCounter = 0;
  const create = vi.fn(async () => {
    ptyCounter += 1;
    return { ok: true as const, ptyId: `pty-${ptyCounter}` };
  });
  const kill = vi.fn(async (_id: string) => {});
  const bridge = {
    platform,
    config: { mode: 'terminal' },
    onMenuAction: () => () => {},
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
    dispatchMenuAction(action: OkMenuAction) {
      emitLocalMenuAction(action);
    },
  };
}

function bridgeWithMode(mode: string): OkDesktopBridge {
  return { config: { mode } } as unknown as OkDesktopBridge;
}

async function addTerminalTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Choose what a new tab starts' }));
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
    __resetLocalMenuActionBusForTests();
  });

  test('Help -> Report a bug reaches this window too', async () => {
    const { bridge } = makeBridge();
    render(
      <TooltipProvider>
        <TerminalWindowApp bridge={bridge} />
      </TooltipProvider>,
    );

    act(() => {
      emitLocalMenuAction('report-bug');
    });

    expect(await screen.findByRole('dialog', {}, { timeout: 15_000 })).not.toBeNull();
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

  test('Ctrl+number switches tabs in a Linux terminal window', async () => {
    const user = userEvent.setup();
    const { bridge } = makeBridge('linux');
    render(
      <TooltipProvider>
        <TerminalWindowApp bridge={bridge} />
      </TooltipProvider>,
    );
    await addTerminalTab(user);

    const event = new KeyboardEvent('keydown', {
      key: '1',
      ctrlKey: true,
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
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {});
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
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {});
    try {
      const view = makeBridge();
      render(
        <TooltipProvider>
          <TerminalWindowApp bridge={view.bridge} />
        </TooltipProvider>,
      );
      await addTerminalTab(user);
      expect(screen.getAllByTestId('terminal-session')).toHaveLength(2);

      act(() => view.dispatchMenuAction('close-active-tab-or-window'));
      expect(screen.getAllByTestId('terminal-session')).toHaveLength(1);
      expect(closeSpy).not.toHaveBeenCalled();

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
    expect(view.viewMenuPushes.at(-1)).toEqual({ terminalLive: true });
  });
});

describe('selectDesktopRootApp routing', () => {
  beforeEach(() => {
    cleanup();
  });
  afterEach(() => {
    cleanup();
    __resetLocalMenuActionBusForTests();
  });

  test('mounting the terminal-mode selection renders the full-window terminal', async () => {
    const { bridge } = makeBridge();
    render(<TooltipProvider>{selectDesktopRootApp(bridge)}</TooltipProvider>);
    expect(
      await screen.findByRole('tablist', { name: 'Terminal sessions' }, { timeout: 5000 }),
    ).toBeTruthy();
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
