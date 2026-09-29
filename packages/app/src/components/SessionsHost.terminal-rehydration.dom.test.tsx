// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { emitLocalMenuAction } from '@/lib/local-menu-action-bus';
import type { TerminalLaunchIntent } from './EditorPane';
import { subscribeToSignInTerminalExits } from './handoff/sign-in-terminal-events';
import {
  dispatchReorderChord,
  dispatchTabChord,
  focusFirstTab,
  tabTitles,
} from './sessions-host-tabs.test-helper';

vi.doMock('@/lib/acp/thread-client', () => ({
  useAgentThreads: () => [],
  useOpenAgentThreadTabs: () => [],
  useInitialRosterThreadIds: () => null,
  useAgentThreadConnection: () => 'open',
  useAgentThreadScope: () => null,
  useAgentThreadUnread: () => false,
  getAgentThreadClient: () => ({
    closeThread: vi.fn(),
    renameThread: vi.fn(),
    openArchivedThread: vi.fn(),
    deleteThread: vi.fn(),
    markThreadViewed: vi.fn(),
  }),
  ThreadChannelUnavailableError: class ThreadChannelUnavailableError extends Error {},
}));

vi.doMock('@/lib/acp/registered-agents', () => ({
  useRegisteredAgents: () => [],
  useDefaultRegisteredAgent: () => null,
  getDefaultRegisteredAgent: () => null,
  registerAgent: vi.fn(),
  pickEffectiveDefaultAgent: () => null,
  hydrateRegisteredAgentMeta: () => {},
}));

vi.doMock('@/lib/acp/launch-agent-thread', () => ({
  launchAgentThread: vi.fn(async () => 'started'),
  hasInflightThreadLaunch: () => false,
}));

vi.doMock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

vi.doMock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined, isLoading: false, isError: false }),
}));

type GateExit = (info: { exitCode: number; signal: number | null }) => void;
const gateExits: Array<GateExit | undefined> = [];

vi.doMock('./TerminalGate', () => ({
  TerminalGate: ({
    adoptPtyId,
    onPtyId,
    onExit,
  }: {
    adoptPtyId?: string | null;
    onPtyId?: (ptyId: string | null) => void;
    onExit?: GateExit;
  }) => {
    useEffect(() => {
      onPtyId?.(adoptPtyId ?? 'pty-fresh');
    }, [adoptPtyId, onPtyId]);
    useEffect(() => {
      gateExits.push(onExit);
    }, [onExit]);
    return <div data-testid="terminal-gate" data-adopt={adoptPtyId ?? ''} />;
  },
}));

const { SessionsHost } = await import('./SessionsHost');

const NEVER = () => new Promise<never>(() => {});

function makeBridge(overrides: Record<string, unknown>): OkDesktopBridge {
  return {
    platform: 'darwin',
    terminal: {
      create: vi.fn(async () => ({ ptyId: 'pty-1' })),
      kill: vi.fn(),
      input: vi.fn(),
      list: vi.fn(async () => []),
      ...overrides,
    },
    editor: { notifyViewMenuStateChanged: vi.fn() },
  } as unknown as OkDesktopBridge;
}

function Harness({
  bridge,
  restoreNonce = 0,
  startVisible = false,
  bumpRestoreAfterMount = false,
  launch = null,
}: {
  bridge: OkDesktopBridge;
  restoreNonce?: number;
  startVisible?: boolean;
  bumpRestoreAfterMount?: boolean;
  launch?: TerminalLaunchIntent | null;
}) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(startVisible);
  const [nonce, setNonce] = useState(restoreNonce);
  useEffect(() => {
    if (container == null || startVisible) return;
    const id = window.setTimeout(() => {
      if (bumpRestoreAfterMount) setNonce((n) => n + 1);
      setVisible(true);
    }, 0);
    return () => window.clearTimeout(id);
  }, [container, startVisible, bumpRestoreAfterMount]);
  return (
    <TooltipProvider>
      <div ref={setContainer} data-testid="dock-container" />
      <SessionsHost
        surface="terminal-dock"
        bridge={bridge}
        terminalCapable
        visible={visible}
        terminalRestoreRevealNonce={nonce}
        launch={launch}
        onVisibleChange={setVisible}
        installedClis={{}}
        container={container}
        isShowing={visible && container != null}
        onRequestEditorFocus={() => {}}
      />
    </TooltipProvider>
  );
}

async function revealAndSettle(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('SessionsHost — terminal dock rehydration must always settle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    gateExits.length = 0;
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  test('a sign-in terminal closing tells the chat that opened it', async () => {
    const seen = vi.fn();
    const stop = subscribeToSignInTerminalExits(seen);
    try {
      render(
        <Harness
          bridge={makeBridge({})}
          launch={{
            prompt: null,
            cli: null,
            command: { executable: 'auggie', args: ['--acp', 'login'] },
            label: 'Log in with Auggie',
            nonce: 1,
            signInThreadId: 't1',
          }}
        />,
      );
      await revealAndSettle(1_000);
      const exit = gateExits.filter((handler) => handler !== undefined).at(-1);
      expect(exit).toBeDefined();
      act(() => exit?.({ exitCode: 0, signal: null }));
      expect(seen).toHaveBeenCalledWith('t1');
    } finally {
      stop();
    }
  });

  test('closing a sign-in tab through its close control tells the chat exactly once', async () => {
    const seen = vi.fn();
    const stop = subscribeToSignInTerminalExits(seen);
    try {
      render(
        <Harness
          bridge={makeBridge({})}
          launch={{
            prompt: null,
            cli: null,
            command: { executable: 'auggie', args: ['--acp', 'login'] },
            label: 'Log in with Auggie',
            nonce: 1,
            signInThreadId: 't1',
          }}
        />,
      );
      await revealAndSettle(1_000);
      const exit = gateExits.filter((handler) => handler !== undefined).at(-1);
      expect(exit).toBeDefined();
      const closeButtons = screen.getAllByRole('button', { name: /^Close / });
      act(() => {
        fireEvent.click(closeButtons[closeButtons.length - 1] as HTMLElement);
      });
      await revealAndSettle(10);
      expect(seen).toHaveBeenCalledTimes(1);
      expect(seen).toHaveBeenCalledWith('t1');
      act(() => exit?.({ exitCode: 0, signal: null }));
      expect(seen).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });

  test('a sign-in shell that exits before its tab closes still tells the chat once', async () => {
    const seen = vi.fn();
    const stop = subscribeToSignInTerminalExits(seen);
    try {
      render(
        <Harness
          bridge={makeBridge({})}
          launch={{
            prompt: null,
            cli: null,
            command: { executable: 'auggie', args: ['--acp', 'login'] },
            label: 'Log in with Auggie',
            nonce: 1,
            signInThreadId: 't1',
          }}
        />,
      );
      await revealAndSettle(1_000);
      const exit = gateExits.filter((handler) => handler !== undefined).at(-1);
      act(() => exit?.({ exitCode: 0, signal: null }));
      expect(seen).toHaveBeenCalledTimes(1);
      const closeButtons = screen.getAllByRole('button', { name: /^Close / });
      act(() => {
        fireEvent.click(closeButtons[closeButtons.length - 1] as HTMLElement);
      });
      await revealAndSettle(10);
      expect(seen).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });

  test('an ordinary terminal closing tells no chat', async () => {
    const seen = vi.fn();
    const stop = subscribeToSignInTerminalExits(seen);
    try {
      render(<Harness bridge={makeBridge({})} launch={{ prompt: null, cli: 'codex', nonce: 1 }} />);
      await revealAndSettle(1_000);
      expect(gateExits.length).toBeGreaterThan(0);
      expect(gateExits.every((handler) => handler === undefined)).toBe(true);
      expect(seen).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  test('a getDockState() that never settles still seeds a terminal on reveal', async () => {
    render(<Harness bridge={makeBridge({ getDockState: NEVER })} />);
    await revealAndSettle(10_000);
    expect(document.querySelector('[data-terminal-session]')).not.toBeNull();
  });

  test('a terminal.list() that never settles still seeds a terminal on reveal', async () => {
    render(<Harness bridge={makeBridge({ list: NEVER })} />);
    await revealAndSettle(10_000);
    expect(document.querySelector('[data-terminal-session]')).not.toBeNull();
  });

  test('a healthy bridge still adopts surviving PTYs rather than cold-seeding', async () => {
    const list = vi.fn(async () => [{ ptyId: 'pty-live', customLabel: null, ordinal: 1 }]);
    render(<Harness bridge={makeBridge({ list })} />);
    await revealAndSettle(1_000);
    expect(list).toHaveBeenCalled();
    const adopted = screen
      .getAllByTestId('terminal-gate')
      .map((el) => el.getAttribute('data-adopt'));
    expect(adopted).toContain('pty-live');
  });

  test('a healthy restore does persist the dock state', async () => {
    const setDockState = vi.fn(async () => ({ ok: true }));
    const getDockState = vi.fn(async () => ({
      terminalVisible: true,
      agentPanelVisible: false,
      terminal: { order: ['pty-saved'], activeKey: 'pty-saved' },
      terminalSnapshot: { tabs: [{ ordinal: 1, customLabel: 'saved' }], activeOrdinal: 1 },
    }));
    render(<Harness bridge={makeBridge({ getDockState, setDockState })} />);
    await revealAndSettle(1_000);
    expect(document.querySelector('[data-terminal-session]')).not.toBeNull();
    expect(setDockState).toHaveBeenCalled();
  });

  test('an abandoned restore does not overwrite the saved tab set it failed to read', async () => {
    const setDockState = vi.fn(async () => ({ ok: true }));
    render(
      <Harness
        bridge={makeBridge({ getDockState: NEVER, setDockState })}
        restoreNonce={1}
        startVisible
      />,
    );
    await revealAndSettle(10_000);
    expect(document.querySelector('[data-terminal-session]')).not.toBeNull();
    expect(screen.getAllByTestId('terminal-gate').length).toBeGreaterThan(0);
    expect(setDockState).not.toHaveBeenCalled();
  });

  test('a rejecting getDockState does not overwrite the saved tab set either', async () => {
    const setDockState = vi.fn(async () => ({ ok: true }));
    const getDockState = vi.fn(async () => {
      throw new Error('ipc exploded');
    });
    render(<Harness bridge={makeBridge({ getDockState, setDockState })} />);
    await revealAndSettle(10_000);
    expect(document.querySelector('[data-terminal-session]')).not.toBeNull();
    expect(setDockState).not.toHaveBeenCalled();
  });

  test('a rejecting getDockState still seeds on a restore reveal when no PTY survived', async () => {
    const getDockState = vi.fn(async () => {
      throw new Error('dock state transport failed');
    });
    render(<Harness bridge={makeBridge({ getDockState })} bumpRestoreAfterMount />);
    await revealAndSettle(1_000);
    expect(document.querySelector('[data-terminal-session]')).not.toBeNull();
  });

  test('a dock visible at mount also seeds when no PTY survived, not just on a later reveal', async () => {
    const getDockState = vi.fn(async () => {
      throw new Error('dock state transport failed');
    });
    render(<Harness bridge={makeBridge({ getDockState })} restoreNonce={1} startVisible />);
    await revealAndSettle(1_000);
    expect(document.querySelector('[data-terminal-session]')).not.toBeNull();
  });

  test('a healthy read that has nothing saved still seeds one terminal', async () => {
    const setDockState = vi.fn(async () => ({ ok: true }));
    const getDockState = vi.fn(async () => ({
      terminalVisible: true,
      agentPanelVisible: false,
      terminalSnapshot: { tabs: [], activeOrdinal: null },
    }));
    render(
      <Harness bridge={makeBridge({ getDockState, setDockState })} restoreNonce={1} startVisible />,
    );
    await revealAndSettle(1_000);
    expect(getDockState).toHaveBeenCalled();
    expect(document.querySelectorAll('[data-terminal-session]')).toHaveLength(1);
    expect(setDockState.mock.calls.at(-1)?.[0]?.order).toHaveLength(1);
  });

  test('a rejecting terminal.list does not overwrite the saved tab set either', async () => {
    const setDockState = vi.fn(async () => ({ ok: true }));
    const getDockState = vi.fn(async () => ({
      terminalVisible: true,
      agentPanelVisible: false,
      terminal: { order: ['pty-a', 'pty-b'], activeKey: 'pty-b' },
      terminalSnapshot: {
        tabs: [
          { ordinal: 1, customLabel: 'build' },
          { ordinal: 2, customLabel: 'server' },
        ],
        activeOrdinal: 2,
      },
    }));
    const list = vi.fn(async () => {
      throw new Error('pty list exploded');
    });
    render(<Harness bridge={makeBridge({ getDockState, list, setDockState })} />);
    await revealAndSettle(10_000);
    expect(getDockState).toHaveBeenCalled();
    expect(document.querySelectorAll('[data-terminal-session]')).toHaveLength(1);
    expect(setDockState).not.toHaveBeenCalled();
  });

  test('a malformed restart snapshot from the bridge still cold-starts rather than wedging', async () => {
    const setDockState = vi.fn(async () => ({ ok: true }));
    const getDockState = vi.fn(async () => ({
      terminalVisible: true,
      agentPanelVisible: false,
      terminalSnapshot: { activeOrdinal: 1 },
    }));
    render(
      <Harness bridge={makeBridge({ getDockState, setDockState })} restoreNonce={1} startVisible />,
    );
    await revealAndSettle(1_000);
    expect(document.querySelectorAll('[data-terminal-session]')).toHaveLength(1);
    expect(setDockState).not.toHaveBeenCalled();
  });

  test('a dock visible at mount does not cold-seed when list() left survivors unknown', async () => {
    const create = vi.fn(async () => ({ ptyId: 'should-not-happen' }));
    const getDockState = vi.fn(async () => ({
      terminalVisible: true,
      agentPanelVisible: false,
      terminal: { order: ['pty-a'], activeKey: 'pty-a' },
      terminalSnapshot: { tabs: [{ ordinal: 1, customLabel: 'build' }], activeOrdinal: 1 },
    }));
    const list = vi.fn(async () => {
      throw new Error('inventory transport failed');
    });
    render(
      <Harness bridge={makeBridge({ create, getDockState, list })} restoreNonce={1} startVisible />,
    );
    await revealAndSettle(10_000);
    expect(document.querySelectorAll('[data-terminal-session]')).toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
  });

  test('a dock restored open at quit still seeds when the restore read never settles', async () => {
    render(<Harness bridge={makeBridge({ getDockState: NEVER })} restoreNonce={1} startVisible />);
    await revealAndSettle(10_000);
    expect(document.querySelector('[data-terminal-session]')).not.toBeNull();
  });

  test('a restore-triggered reveal still seeds once the restore is abandoned', async () => {
    render(<Harness bridge={makeBridge({ getDockState: NEVER })} bumpRestoreAfterMount />);
    await revealAndSettle(10_000);
    expect(document.querySelector('[data-terminal-session]')).not.toBeNull();
  });

  test('a restore resolving after the deadline neither replaces nor duplicates the seeded session', async () => {
    let resolveList: ((v: unknown[]) => void) | undefined;
    const list = vi.fn(
      () =>
        new Promise((r) => {
          resolveList = r as (v: unknown[]) => void;
        }),
    );
    render(<Harness bridge={makeBridge({ list })} />);
    await revealAndSettle(10_000);
    const before = document.querySelectorAll('[data-terminal-session]').length;
    expect(before).toBeGreaterThan(0);
    const adoptedBefore = screen
      .getAllByTestId('terminal-gate')
      .map((el) => el.getAttribute('data-adopt'));
    resolveList?.([{ ptyId: 'pty-late', customLabel: null, ordinal: 1 }]);
    await revealAndSettle(100);
    expect(document.querySelectorAll('[data-terminal-session]').length).toBe(before);
    const adoptedAfter = screen
      .getAllByTestId('terminal-gate')
      .map((el) => el.getAttribute('data-adopt'));
    expect(adoptedAfter).toEqual(adoptedBefore);
    expect(adoptedAfter).not.toContain('pty-late');
  });

  test('after a rejected read, the user reordering the tabs releases suppression and persists the arrangement', async () => {
    const setDockState = vi.fn(async () => ({ ok: true }));
    const getDockState = vi.fn(async () => {
      throw new Error('ipc exploded');
    });
    const list = vi.fn(async () => [
      { ptyId: 'pty-a', customLabel: 'build', ordinal: 1 },
      { ptyId: 'pty-b', customLabel: 'server', ordinal: 2 },
    ]);
    render(
      <Harness
        bridge={makeBridge({ getDockState, list, setDockState })}
        restoreNonce={1}
        startVisible
      />,
    );
    await revealAndSettle(1_000);

    expect(tabTitles()).toEqual(['build', 'server']);
    expect(setDockState).not.toHaveBeenCalled();

    focusFirstTab();
    expect(dispatchReorderChord('ArrowRight').defaultPrevented).toBe(true);
    await revealAndSettle(0);

    expect(tabTitles()).toEqual(['server', 'build']);
    const writes = setDockState.mock.calls.filter(
      (call) => (call[0] as { surface?: string }).surface === 'terminal',
    );
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.at(-1)?.[0]).toMatchObject({
      surface: 'terminal',
      order: ['pty-b', 'pty-a'],
    });
  });

  test('after a rejected read, opening a new tab releases suppression and persists the grown tab set', async () => {
    const setDockState = vi.fn(async () => ({ ok: true }));
    const getDockState = vi.fn(async () => {
      throw new Error('ipc exploded');
    });
    const list = vi.fn(async () => [
      { ptyId: 'pty-a', customLabel: 'build', ordinal: 1 },
      { ptyId: 'pty-b', customLabel: 'server', ordinal: 2 },
    ]);
    render(
      <Harness
        bridge={makeBridge({ getDockState, list, setDockState })}
        restoreNonce={1}
        startVisible
      />,
    );
    await revealAndSettle(1_000);

    expect(tabTitles()).toEqual(['build', 'server']);
    expect(setDockState).not.toHaveBeenCalled();

    act(() => {
      emitLocalMenuAction('new-terminal');
    });
    await revealAndSettle(0);

    expect(tabTitles()).toHaveLength(3);
    const writes = setDockState.mock.calls.filter(
      (call) => (call[0] as { surface?: string }).surface === 'terminal',
    );
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.at(-1)?.[0]).toMatchObject({
      surface: 'terminal',
      order: ['pty-a', 'pty-b', 'pty-fresh'],
    });
  });

  test('after a rejected read, the tab chord releases suppression and persists the active key', async () => {
    const setDockState = vi.fn(async () => ({ ok: true }));
    const getDockState = vi.fn(async () => {
      throw new Error('ipc exploded');
    });
    const list = vi.fn(async () => [
      { ptyId: 'pty-a', customLabel: 'build', ordinal: 1 },
      { ptyId: 'pty-b', customLabel: 'server', ordinal: 2 },
    ]);
    render(
      <Harness
        bridge={makeBridge({ getDockState, list, setDockState })}
        restoreNonce={1}
        startVisible
      />,
    );
    await revealAndSettle(1_000);

    expect(tabTitles()).toEqual(['build', 'server']);
    expect(setDockState).not.toHaveBeenCalled();

    act(() => {
      screen.getByTestId('terminal-new-chat').focus();
    });
    await revealAndSettle(0);
    expect(setDockState).not.toHaveBeenCalled();

    expect(dispatchTabChord('1').defaultPrevented).toBe(true);
    await revealAndSettle(0);

    expect(tabTitles()).toEqual(['build', 'server']);
    const writes = setDockState.mock.calls.filter(
      (call) => (call[0] as { surface?: string }).surface === 'terminal',
    );
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.at(-1)?.[0]).toMatchObject({
      surface: 'terminal',
      order: ['pty-a', 'pty-b'],
      activeKey: 'pty-a',
    });
  });

  test('after a rejected read, selecting a tab in the strip releases suppression on its own', async () => {
    const setDockState = vi.fn(async () => ({ ok: true }));
    const getDockState = vi.fn(async () => {
      throw new Error('ipc exploded');
    });
    const list = vi.fn(async () => [
      { ptyId: 'pty-a', customLabel: 'build', ordinal: 1 },
      { ptyId: 'pty-b', customLabel: 'server', ordinal: 2 },
    ]);
    render(
      <Harness
        bridge={makeBridge({ getDockState, list, setDockState })}
        restoreNonce={1}
        startVisible
      />,
    );
    await revealAndSettle(1_000);

    expect(tabTitles()).toEqual(['build', 'server']);
    expect(setDockState).not.toHaveBeenCalled();

    focusFirstTab();
    await revealAndSettle(0);

    const writes = setDockState.mock.calls.filter(
      (call) => (call[0] as { surface?: string }).surface === 'terminal',
    );
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.at(-1)?.[0]).toMatchObject({
      surface: 'terminal',
      order: ['pty-a', 'pty-b'],
      activeKey: 'pty-a',
    });
  });

  test('after a rejected read, adopting PTYs alone never releases suppression', async () => {
    const setDockState = vi.fn(async () => ({ ok: true }));
    const getDockState = vi.fn(async () => {
      throw new Error('ipc exploded');
    });
    const list = vi.fn(async () => [
      { ptyId: 'pty-a', customLabel: 'build', ordinal: 1 },
      { ptyId: 'pty-b', customLabel: 'server', ordinal: 2 },
    ]);
    render(
      <Harness
        bridge={makeBridge({ getDockState, list, setDockState })}
        restoreNonce={1}
        startVisible
      />,
    );
    await revealAndSettle(10_000);

    expect(tabTitles()).toEqual(['build', 'server']);
    expect(setDockState).not.toHaveBeenCalled();
  });
});
