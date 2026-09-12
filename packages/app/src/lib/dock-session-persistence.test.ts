import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import {
  readDockRestoreState,
  readDockSessionOrder,
  readWebDockSessionOrder,
  writeDockSessionOrder,
} from './dock-session-persistence';

function makeDesktopBridge(
  initial: Partial<{
    terminal: { order: string[]; activeKey: string | null };
    agents: { order: string[]; activeKey: string | null };
  }> = {},
) {
  const store = { ...initial };
  const setDockState = vi.fn(
    (state: {
      surface: 'terminal' | 'agents';
      order: string[];
      activeKey: string | null;
      terminalSnapshot?: { tabs: []; activeOrdinal: null };
    }) => {
      store[state.surface] = { order: state.order, activeKey: state.activeKey };
    },
  );
  const bridge = {
    terminal: {
      getDockState: async () => ({
        terminalVisible: false,
        agentPanelVisible: false,
        terminal: store.terminal,
        agents: store.agents,
      }),
      setDockState,
    },
  } as unknown as OkDesktopBridge;
  return { bridge, store, setDockState };
}

function makeLocalStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}
let localStorageStub: ReturnType<typeof makeLocalStorage>;

beforeEach(() => {
  localStorageStub = makeLocalStorage();
  vi.stubGlobal('window', { localStorage: localStorageStub });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('web backend (localStorage)', () => {
  test('each surface owns its own key, so neither read sees the other', () => {
    writeDockSessionOrder(null, 'terminal', { order: ['pty-1', 'pty-2'], activeKey: 'pty-2' });
    writeDockSessionOrder(null, 'agents', { order: ['thread-a'], activeKey: 'thread-a' });

    expect(readWebDockSessionOrder('terminal')).toEqual({
      order: ['pty-1', 'pty-2'],
      activeKey: 'pty-2',
    });
    expect(readWebDockSessionOrder('agents')).toEqual({
      order: ['thread-a'],
      activeKey: 'thread-a',
    });
  });

  test("one panel's write cannot erase the other's order", () => {
    writeDockSessionOrder(null, 'terminal', { order: ['pty-1'], activeKey: 'pty-1' });
    writeDockSessionOrder(null, 'agents', { order: ['thread-a'], activeKey: 'thread-a' });

    expect(readWebDockSessionOrder('terminal')).toEqual({ order: ['pty-1'], activeKey: 'pty-1' });
  });

  test('an unwritten surface reads null so the caller cold-starts', () => {
    writeDockSessionOrder(null, 'terminal', { order: ['pty-1'], activeKey: 'pty-1' });
    expect(readWebDockSessionOrder('agents')).toBeNull();
  });

  test('a corrupt record reads null rather than throwing into the mount seed', () => {
    localStorageStub.setItem('ok-dock-session-order-v1', 'not json');
    expect(readWebDockSessionOrder('terminal')).toBeNull();
  });

  test('non-string keys are dropped rather than restored as junk tabs', () => {
    localStorageStub.setItem(
      'ok-agent-session-order-v1',
      JSON.stringify({ order: ['thread-a', 7, null], activeKey: 42 }),
    );
    expect(readWebDockSessionOrder('agents')).toEqual({ order: ['thread-a'], activeKey: null });
  });
});

describe('desktop backend (bridge)', () => {
  test('reads the sub-record for the asked-for surface only', async () => {
    const { bridge } = makeDesktopBridge({
      terminal: { order: ['pty-1'], activeKey: 'pty-1' },
      agents: { order: ['thread-a', 'thread-b'], activeKey: 'thread-b' },
    });

    await expect(readDockSessionOrder(bridge, 'terminal')).resolves.toEqual({
      order: ['pty-1'],
      activeKey: 'pty-1',
    });
    await expect(readDockSessionOrder(bridge, 'agents')).resolves.toEqual({
      order: ['thread-a', 'thread-b'],
      activeKey: 'thread-b',
    });
  });

  test('reads session order and the terminal restart snapshot from one bridge state', async () => {
    const getDockState = vi.fn(async () => ({
      terminalVisible: true,
      agentPanelVisible: false,
      terminal: { order: ['pty-1'], activeKey: 'pty-1' },
      terminalSnapshot: {
        tabs: [{ ordinal: 1, customLabel: 'deploy' }],
        activeOrdinal: 1,
      },
    }));
    const bridge = { terminal: { getDockState } } as unknown as OkDesktopBridge;

    await expect(readDockRestoreState(bridge, 'terminal')).resolves.toEqual({
      sessionOrder: { order: ['pty-1'], activeKey: 'pty-1' },
      failed: false,
      terminalSnapshot: {
        tabs: [{ ordinal: 1, customLabel: 'deploy' }],
        activeOrdinal: 1,
      },
    });
    expect(getDockState).toHaveBeenCalledOnce();
  });

  test('writes carry the surface, so main files them apart', () => {
    const { bridge, setDockState, store } = makeDesktopBridge();

    writeDockSessionOrder(bridge, 'agents', { order: ['thread-a'], activeKey: 'thread-a' });
    writeDockSessionOrder(bridge, 'terminal', { order: ['pty-1'], activeKey: null });

    expect(setDockState).toHaveBeenNthCalledWith(1, {
      surface: 'agents',
      order: ['thread-a'],
      activeKey: 'thread-a',
    });
    expect(store.agents).toEqual({ order: ['thread-a'], activeKey: 'thread-a' });
    expect(store.terminal).toEqual({ order: ['pty-1'], activeKey: null });
    expect(setDockState).toHaveBeenNthCalledWith(2, {
      surface: 'terminal',
      order: ['pty-1'],
      activeKey: null,
      terminalSnapshot: { tabs: [], activeOrdinal: null },
    });
  });

  test('window-teardown writes warn without reporting a persistence error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bridge = {
      terminal: {
        setDockState: async () => ({ ok: false as const, reason: 'ipc-unavailable' as const }),
      },
    } as unknown as OkDesktopBridge;

    writeDockSessionOrder(bridge, 'terminal', { order: ['pty-1'], activeKey: 'pty-1' });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());

    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[dock-session-persistence] setDockState skipped during window teardown',
    );
  });

  test('an absent sub-record reads null (fresh launch → cold start)', async () => {
    const { bridge } = makeDesktopBridge({ terminal: { order: ['pty-1'], activeKey: 'pty-1' } });
    await expect(readDockSessionOrder(bridge, 'agents')).resolves.toBeNull();
  });

  test('an empty retained record reads null rather than seeding an empty arrangement', async () => {
    const { bridge } = makeDesktopBridge({ agents: { order: [], activeKey: null } });
    await expect(readDockSessionOrder(bridge, 'agents')).resolves.toBeNull();
  });

  test('a rejecting getDockState reads null so the host cold-starts instead of hanging', async () => {
    const bridge = {
      terminal: {
        getDockState: async () => {
          throw new Error('ipc torn down mid-reload');
        },
        setDockState: () => {},
      },
    } as unknown as OkDesktopBridge;

    await expect(readDockSessionOrder(bridge, 'terminal')).resolves.toBeNull();
  });

  test('a rejecting dock-state read settles the complete restore state', async () => {
    const bridge = {
      terminal: {
        getDockState: async () => {
          throw new Error('ipc torn down mid-reload');
        },
      },
    } as unknown as OkDesktopBridge;

    await expect(readDockRestoreState(bridge, 'terminal')).resolves.toEqual({
      sessionOrder: null,
      terminalSnapshot: undefined,
      failed: true,
    });
  });

  test('an absent sub-record is a successful read, not a failed one', async () => {
    const bridge = {
      terminal: {
        list: async () => [],
        getDockState: async () => ({ terminalSnapshot: { tabs: [], activeOrdinal: null } }),
      },
    } as unknown as OkDesktopBridge;

    await expect(readDockRestoreState(bridge, 'terminal')).resolves.toEqual({
      sessionOrder: null,
      terminalSnapshot: { tabs: [], activeOrdinal: null },
      failed: false,
    });
  });

  test('a live terminal bridge without dock-state capability ignores stale web order', async () => {
    writeDockSessionOrder(null, 'terminal', { order: ['stale-pty'], activeKey: 'stale-pty' });
    const bridge = { terminal: { list: async () => [] } } as unknown as OkDesktopBridge;

    await expect(readDockRestoreState(bridge, 'terminal')).resolves.toEqual({
      sessionOrder: null,
      terminalSnapshot: undefined,
      failed: false,
    });

    writeDockSessionOrder(bridge, 'terminal', { order: ['desktop-pty'], activeKey: null });
    expect(readWebDockSessionOrder('terminal')).toEqual({
      order: ['stale-pty'],
      activeKey: 'stale-pty',
    });
  });

  test('a bridge with no dock-state methods falls back to the web backend', async () => {
    const sessionOnly = { editor: {} } as unknown as OkDesktopBridge;
    writeDockSessionOrder(sessionOnly, 'terminal', { order: ['pty-1'], activeKey: 'pty-1' });

    expect(localStorageStub.getItem('ok-dock-session-order-v1')).not.toBeNull();
    await expect(readDockSessionOrder(sessionOnly, 'terminal')).resolves.toEqual({
      order: ['pty-1'],
      activeKey: 'pty-1',
    });
  });
});
