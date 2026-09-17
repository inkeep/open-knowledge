import type { ThreadInfo } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { requestSendToOpenChat, subscribeSendInThread } from '@/comments/open-chat-send';
import { TooltipProvider } from '@/components/ui/tooltip';
import { collectImageParts } from '@/editor/composer-drop.test-helper';
import {
  inAppEnabledKey,
  reloadEnabledAgentsFromStorage,
  setAgentEnabled,
} from '@/lib/acp/enabled-agents';
import { subscribeStagedThreadDraft } from '@/lib/acp/thread-draft-staging';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import type { ThreadLaunchIntent } from './EditorPane';
import { requestPreferredSession } from './handoff/preferred-session-events';
import { requestActiveTerminalInput } from './handoff/terminal-input-events';
import { subscribeToTerminalLaunchRequests } from './handoff/terminal-launch-events';
import { _resetReusableSession, getReusableSession } from './reusable-session-store';
import {
  dispatchReorderChord,
  dispatchTabChord,
  focusFirstTab,
  tabTitles,
} from './sessions-host-tabs.test-helper';

let openThreads: ThreadInfo[] = [];
const storeListeners = new Set<() => void>();
let archivedThreads: ThreadInfo[] = [];
let agentThreads: ThreadInfo[] = [];
let initialRosterIds: ReadonlySet<string> | null = null;
let threadScope: string | null = 'ws://project-a/collab/thread';
function refreshAgentThreads() {
  const byId = new Map(archivedThreads.map((thread) => [thread.threadId, thread]));
  for (const thread of openThreads) byId.set(thread.threadId, thread);
  agentThreads = [...byId.values()];
}
function notifyStore() {
  for (const l of storeListeners) l();
}
function setInitialRosterIds(next: ReadonlySet<string> | null) {
  initialRosterIds = next;
  notifyStore();
}
function setThreadScope(next: string | null) {
  threadScope = next;
  notifyStore();
}
function setOpenThreads(next: ThreadInfo[]) {
  openThreads = next;
  refreshAgentThreads();
  notifyStore();
}
function setArchivedThreads(next: ThreadInfo[]) {
  archivedThreads = next;
  refreshAgentThreads();
  notifyStore();
}
const closeThread = vi.fn((id: string) => {
  setOpenThreads(openThreads.filter((thread) => thread.threadId !== id));
});
const renameThread = vi.fn((_id: string, _title: string) => {});
const openArchivedThread = vi.fn((id: string) => {
  const thread = archivedThreads.find((t) => t.threadId === id);
  if (thread != null) setOpenThreads([...openThreads, thread]);
});
const deleteThread = vi.fn((id: string) => {
  setArchivedThreads(archivedThreads.filter((t) => t.threadId !== id));
});
const markThreadViewed = vi.fn((_id: string) => {});

let connectionStatus: 'idle' | 'connecting' | 'open' | 'closed' = 'open';
function setConnectionStatus(next: typeof connectionStatus) {
  connectionStatus = next;
  notifyStore();
}

function subscribeStore(cb: () => void) {
  storeListeners.add(cb);
  return () => storeListeners.delete(cb);
}

vi.doMock('@/lib/acp/thread-client', () => ({
  useAgentThreads: () =>
    useSyncExternalStore(
      subscribeStore,
      () => agentThreads,
      () => agentThreads,
    ),
  useOpenAgentThreadTabs: () =>
    useSyncExternalStore(
      subscribeStore,
      () => openThreads,
      () => openThreads,
    ),
  useInitialRosterThreadIds: () =>
    useSyncExternalStore(
      subscribeStore,
      () => initialRosterIds,
      () => initialRosterIds,
    ),
  useAgentThreadConnection: () =>
    useSyncExternalStore(
      subscribeStore,
      () => connectionStatus,
      () => connectionStatus,
    ),
  useAgentThreadScope: () =>
    useSyncExternalStore(
      subscribeStore,
      () => threadScope,
      () => threadScope,
    ),
  useAgentThreadUnread: () => false,
  getAgentThreadClient: () => ({
    closeThread,
    renameThread,
    openArchivedThread,
    deleteThread,
    markThreadViewed,
  }),
  ThreadChannelUnavailableError: class ThreadChannelUnavailableError extends Error {},
}));

let threadViewHeld = false;
let threadComposerDisabled = false;
const renderThreadView = vi.fn(({ info }: { info: ThreadInfo }) =>
  threadViewHeld ? (
    <div data-testid="thread-view-pending" data-thread-id={info.threadId} />
  ) : (
    <div data-testid="thread-view" data-thread-id={info.threadId}>
      <textarea data-testid="agent-thread-composer" disabled={threadComposerDisabled} />
    </div>
  ),
);
vi.doMock('@/components/acp/ThreadView', () => ({
  ThreadView: renderThreadView,
}));

type MockAgent = {
  source: 'registry' | 'custom';
  id: string;
  name: string;
  supported?: boolean;
};

let mockRegisteredAgent: MockAgent | null = null;
let mockPersistedDefaultAgent: MockAgent | null = null;
const registerAgent = vi.fn((_agent: MockAgent) => {});

const { pickEffectiveDefaultAgent } = await vi.importActual<
  typeof import('@/lib/acp/registered-agents')
>('@/lib/acp/registered-agents');

function presentedAgents(): MockAgent[] {
  const list = mockRegisteredAgent === null ? [] : [mockRegisteredAgent];
  const persisted = mockPersistedDefaultAgent;
  if (
    persisted !== null &&
    !list.some((a) => a.source === persisted.source && a.id === persisted.id)
  )
    list.push(persisted);
  return list;
}

vi.doMock('@/lib/acp/registered-agents', () => ({
  useRegisteredAgents: presentedAgents,
  useDefaultRegisteredAgent: () => mockPersistedDefaultAgent,
  getDefaultRegisteredAgent: () => mockPersistedDefaultAgent,
  registerAgent,
  pickEffectiveDefaultAgent,
  hydrateRegisteredAgentMeta: () => {},
}));

let mockInflightLaunch = false;
let mockLaunchOutcome: 'started' | 'deduped' | 'failed' = 'started';
const launchAgentThread = vi.fn(() => {
  mockInflightLaunch = true;
  return Promise.resolve(mockLaunchOutcome);
});
const toastError = vi.fn((_message: string) => {});
vi.doMock('sonner', () => ({
  toast: { error: toastError, info: vi.fn(), success: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));
vi.doMock('@/lib/acp/launch-agent-thread', () => ({
  launchAgentThread,
  hasInflightThreadLaunch: () => mockInflightLaunch,
}));

let catalogData: unknown;
let catalogLoading = false;
let catalogError: Error | null = null;
const refetchCatalog = vi.fn(() => Promise.resolve());
vi.doMock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: catalogData,
    isLoading: catalogLoading,
    isError: catalogError !== null,
    error: catalogError,
    refetch: refetchCatalog,
  }),
}));

const { SessionsHost } = await import('./SessionsHost');

const FIRST_AGENT = { id: 'a1', name: 'First Agent', source: 'registry' } as const;
const SECOND_AGENT = { id: 'a2', name: 'Second Agent', source: 'registry' } as const;

function makeThread(overrides: Partial<ThreadInfo> & { threadId: string }): ThreadInfo {
  return {
    agent: { id: 'a', name: 'Agent', source: 'registry' },
    title: overrides.threadId,
    status: 'ready',
    createdAt: 1,
    lastActivityAt: 1,
    lastSeq: 0,
    archived: false,
    ...overrides,
  };
}

function lastThreadViewActive(threadId: string): boolean | undefined {
  const calls = renderThreadView.mock.calls.filter(
    ([props]) => (props as { info: ThreadInfo }).info.threadId === threadId,
  );
  const last = calls.at(-1)?.[0] as { active?: boolean } | undefined;
  return last?.active;
}

function agentsDockWrites(setDockState: ReturnType<typeof vi.fn>) {
  return setDockState.mock.calls.filter(
    (call) => (call[0] as { surface?: string }).surface === 'agents',
  );
}

function makeTerminalBridge(): OkDesktopBridge {
  return {
    terminal: {
      create: vi.fn(async () => ({ ptyId: 'pty-1' })),
      kill: vi.fn(),
      input: vi.fn(),
      list: vi.fn(async () => []),
    },
    editor: { notifyViewMenuStateChanged: vi.fn() },
  } as unknown as OkDesktopBridge;
}

type HarnessControl = {
  setVisible: (v: boolean) => void;
  setThreadLaunch: (t: ThreadLaunchIntent | null) => void;
  setRestoreSettled: (v: boolean) => void;
  setBridge: (b: OkDesktopBridge | null) => void;
  rerender: () => void;
};

function makeControl(): { current: HarnessControl | null } {
  return { current: null };
}

function Harness({
  bridge: initialBridge = null,
  initialVisible = true,
  onVisibleChange,
  threadLaunch: initialThreadLaunch = null,
  control,
  initiallyRestoreSettled = true,
  onRequestEditorFocus,
}: {
  bridge?: OkDesktopBridge | null;
  initialVisible?: boolean;
  onVisibleChange?: (v: boolean) => void;
  threadLaunch?: ThreadLaunchIntent | null;
  control?: { current: HarnessControl | null };
  initiallyRestoreSettled?: boolean;
  onRequestEditorFocus?: () => void;
}) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(initialVisible);
  const [threadLaunch, setThreadLaunch] = useState(initialThreadLaunch);
  const [restoreSettled, setRestoreSettled] = useState(initiallyRestoreSettled);
  const [bridge, setBridge] = useState(initialBridge);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (control != null)
      control.current = {
        setVisible,
        setThreadLaunch,
        setRestoreSettled,
        setBridge,
        rerender: () => setTick((n) => n + 1),
      };
  }, [control]);
  return (
    <TooltipProvider>
      <div ref={setContainer} data-testid="dock-container" />
      <SessionsHost
        surface="agents-panel"
        bridge={bridge}
        terminalCapable={bridge != null}
        visible={visible}
        agentsVisibilityRestoreSettled={restoreSettled}
        threadLaunch={threadLaunch}
        onVisibleChange={(v) => {
          onVisibleChange?.(v);
          setVisible(v);
        }}
        installedClis={{}}
        container={container}
        isShowing={visible && container != null}
        onRequestEditorFocus={onRequestEditorFocus ?? (() => {})}
      />
    </TooltipProvider>
  );
}

describe('SessionsHost — agents desktop order-restore gate', () => {
  beforeEach(() => {
    openThreads = [];
    archivedThreads = [];
    agentThreads = [];
    initialRosterIds = null;
    threadScope = 'ws://project-a/collab/thread';
    localStorage.clear();
  });

  test('a hung order restore settles at the deadline: persistence stays suppressed, the warn fires, and a late read does not clobber placement', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let resolveDockState: (state: unknown) => void = () => {};
    const setDockState = vi.fn(() => ({ ok: true as const }));
    const bridge = {
      terminal: {
        getDockState: () =>
          new Promise((resolve) => {
            resolveDockState = resolve;
          }),
        setDockState,
      },
      editor: { notifyViewMenuStateChanged: vi.fn() },
    } as unknown as OkDesktopBridge;

    try {
      render(<Harness bridge={bridge} initialVisible={false} />);

      expect(setDockState).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(
        warnSpy.mock.calls.some((call) =>
          String(call[0]).includes('dock order restore exceeded its 5000ms bound'),
        ),
      ).toBe(true);
      expect(
        warnSpy.mock.calls.some((call) =>
          String(call[0]).includes('the saved tab set is left untouched'),
        ),
      ).toBe(true);

      act(() => {
        setOpenThreads([
          makeThread({ threadId: 't1', title: 'One' }),
          makeThread({ threadId: 't2', title: 'Two', createdAt: 2, lastActivityAt: 2 }),
        ]);
      });
      expect(agentsDockWrites(setDockState)).toHaveLength(0);
      expect(
        warnSpy.mock.calls.some((call) =>
          String(call[0]).includes('[agents] dock persistence withheld'),
        ),
      ).toBe(true);

      await act(async () => {
        resolveDockState({
          terminalVisible: false,
          agentPanelVisible: false,
          agents: { order: ['t2', 't1'], activeKey: null },
        });
      });

      act(() => {
        setOpenThreads([makeThread({ threadId: 't1', title: 'One' })]);
      });
      act(() => {
        setOpenThreads([
          makeThread({ threadId: 't1', title: 'One' }),
          makeThread({ threadId: 't2', title: 'Two', createdAt: 2, lastActivityAt: 2 }),
        ]);
      });

      expect(agentsDockWrites(setDockState)).toHaveLength(0);
      expect(screen.getByRole('tab', { name: /One/ })).toBeDefined();
      const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
      expect(tabs.indexOf('Two')).toBeGreaterThan(tabs.indexOf('One'));
    } finally {
      vi.useRealTimers();
      warnSpy.mockRestore();
    }
  });

  test('a REJECTING dock-state read suppresses agents persistence so the saved order survives', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setDockState = vi.fn(() => ({ ok: true as const }));
    const bridge = {
      terminal: {
        getDockState: () => Promise.reject(new Error('ipc torn down mid-reload')),
        setDockState,
      },
      editor: { notifyViewMenuStateChanged: vi.fn() },
    } as unknown as OkDesktopBridge;

    try {
      render(<Harness bridge={bridge} initialVisible={false} />);
      await act(async () => {});

      act(() => {
        setOpenThreads([
          makeThread({ threadId: 't1', title: 'One' }),
          makeThread({ threadId: 't2', title: 'Two', createdAt: 2, lastActivityAt: 2 }),
        ]);
      });

      expect(agentsDockWrites(setDockState)).toHaveLength(0);
      expect(
        warnSpy.mock.calls.some((call) =>
          String(call[0]).includes('[agents] dock persistence withheld'),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('a completed order restore persists a genuine change with the restored placement', async () => {
    let resolveDockState: (state: unknown) => void = () => {};
    const setDockState = vi.fn(() => ({ ok: true as const }));
    const bridge = {
      terminal: {
        getDockState: () =>
          new Promise((resolve) => {
            resolveDockState = resolve;
          }),
        setDockState,
      },
      editor: { notifyViewMenuStateChanged: vi.fn() },
    } as unknown as OkDesktopBridge;

    render(<Harness bridge={bridge} initialVisible={false} />);

    await act(async () => {
      resolveDockState({
        terminalVisible: false,
        agentPanelVisible: false,
        agents: { order: ['t2', 't1'], activeKey: 't2' },
      });
    });

    act(() => {
      setOpenThreads([
        makeThread({ threadId: 't1', title: 'One' }),
        makeThread({ threadId: 't2', title: 'Two', createdAt: 2, lastActivityAt: 2 }),
      ]);
    });

    const writes = agentsDockWrites(setDockState);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.at(-1)?.[0]).toMatchObject({ surface: 'agents', order: ['t2', 't1'] });
  });

  test('a history selection made during restore wins over the late saved selection', async () => {
    const user = userEvent.setup();
    let resolveDockState: (state: unknown) => void = () => {};
    const bridge = {
      terminal: {
        getDockState: () =>
          new Promise((resolve) => {
            resolveDockState = resolve;
          }),
        setDockState: vi.fn(() => ({ ok: true as const })),
      },
      editor: { notifyViewMenuStateChanged: vi.fn() },
    } as unknown as OkDesktopBridge;
    setOpenThreads([
      makeThread({ threadId: 'a', title: 'Alpha' }),
      makeThread({ threadId: 'b', title: 'Beta', createdAt: 2, lastActivityAt: 2 }),
    ]);
    render(<Harness bridge={bridge} />);
    await screen.findByRole('tab', { name: /Alpha/ });

    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    await user.click(screen.getByTestId('agent-thread-history-open-a'));
    await act(async () => {
      resolveDockState({
        terminalVisible: false,
        agentPanelVisible: true,
        agents: { order: ['a', 'b'], activeKey: 'b' },
      });
    });

    expect(screen.getByRole('tab', { name: /Alpha/ }).getAttribute('aria-selected')).toBe('true');
  });

  test('a completed order restore does not persist the empty settle beat before the roster lands', async () => {
    let resolveDockState: (state: unknown) => void = () => {};
    const setDockState = vi.fn(() => ({ ok: true as const }));
    const bridge = {
      terminal: {
        getDockState: () =>
          new Promise((resolve) => {
            resolveDockState = resolve;
          }),
        setDockState,
      },
      editor: { notifyViewMenuStateChanged: vi.fn() },
    } as unknown as OkDesktopBridge;

    render(<Harness bridge={bridge} initialVisible={false} />);

    await act(async () => {
      resolveDockState({
        terminalVisible: false,
        agentPanelVisible: false,
        agents: { order: ['t2', 't1'], activeKey: 't2' },
      });
    });
    await act(async () => {});

    expect(agentsDockWrites(setDockState)).toEqual([]);

    act(() => {
      setOpenThreads([
        makeThread({ threadId: 't1', title: 'One' }),
        makeThread({ threadId: 't2', title: 'Two', createdAt: 2, lastActivityAt: 2 }),
      ]);
    });

    const writes = agentsDockWrites(setDockState);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.at(-1)?.[0]).toMatchObject({ surface: 'agents', order: ['t2', 't1'] });
  });

  test('a thread going live before the visibility restore settles reveals the dock once the gate opens', async () => {
    const onVisibleChange = vi.fn((_v: boolean) => {});
    const control = makeControl();
    render(
      <Harness
        initialVisible={false}
        onVisibleChange={onVisibleChange}
        control={control}
        initiallyRestoreSettled={false}
      />,
    );
    await act(async () => {});
    expect(onVisibleChange).not.toHaveBeenCalled();

    act(() => {
      setOpenThreads([makeThread({ threadId: 't1', title: 'Window arrival' })]);
    });
    expect(onVisibleChange).not.toHaveBeenCalled();

    act(() => {
      control.current?.setRestoreSettled(true);
    });

    await waitFor(() => expect(onVisibleChange).toHaveBeenCalledWith(true));
  });

  test('a hung agents order restore settles without starting a thread', () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockRegisteredAgent = { source: 'registry', id: 'claude-acp', name: 'Claude Agent' };
    launchAgentThread.mockClear();
    const bridge = {
      terminal: {
        getDockState: () => new Promise(() => {}),
        setDockState: vi.fn(() => ({ ok: true as const })),
      },
      editor: { notifyViewMenuStateChanged: vi.fn() },
    } as unknown as OkDesktopBridge;

    try {
      render(<Harness bridge={bridge} initialVisible />);

      act(() => {
        vi.advanceTimersByTime(5_000);
      });

      expect(
        warnSpy.mock.calls.some((call) =>
          String(call[0]).includes('dock order restore exceeded its 5000ms bound'),
        ),
      ).toBe(true);
      expect(launchAgentThread).not.toHaveBeenCalled();
    } finally {
      mockRegisteredAgent = null;
      vi.useRealTimers();
      warnSpy.mockRestore();
    }
  });

  test('a first roster frame that arrives EMPTY still delivers the empty agents order once settled', async () => {
    let resolveDockState: (state: unknown) => void = () => {};
    const setDockState = vi.fn(() => ({ ok: true as const }));
    const bridge = {
      terminal: {
        getDockState: () =>
          new Promise((resolve) => {
            resolveDockState = resolve;
          }),
        setDockState,
      },
      editor: { notifyViewMenuStateChanged: vi.fn() },
    } as unknown as OkDesktopBridge;

    render(<Harness bridge={bridge} initialVisible={false} />);

    await act(async () => {
      resolveDockState({ terminalVisible: false, agentPanelVisible: false });
    });
    await act(async () => {});

    expect(agentsDockWrites(setDockState)).toEqual([]);

    act(() => {
      setInitialRosterIds(new Set());
    });

    const writes = agentsDockWrites(setDockState);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.at(-1)?.[0]).toMatchObject({ surface: 'agents', order: [], activeKey: null });
  });

  test('after a REJECTED read, the user reordering the tabs releases suppression and persists the arrangement', async () => {
    const setDockState = vi.fn(() => ({ ok: true as const }));
    const bridge = {
      platform: 'darwin',
      terminal: {
        getDockState: () => Promise.reject(new Error('ipc torn down mid-reload')),
        setDockState,
      },
      editor: { notifyViewMenuStateChanged: vi.fn() },
    } as unknown as OkDesktopBridge;

    render(<Harness bridge={bridge} initialVisible />);
    await act(async () => {});

    act(() => {
      setOpenThreads([
        makeThread({ threadId: 't1', title: 'One' }),
        makeThread({ threadId: 't2', title: 'Two', createdAt: 2, lastActivityAt: 2 }),
      ]);
    });
    expect(agentsDockWrites(setDockState)).toHaveLength(0);

    focusFirstTab();
    expect(dispatchReorderChord('ArrowRight').defaultPrevented).toBe(true);

    expect(tabTitles()).toEqual(['Two', 'One']);
    const writes = agentsDockWrites(setDockState);
    expect(writes).toHaveLength(2);
    expect(writes[0]?.[0]).toMatchObject({
      surface: 'agents',
      order: ['t1', 't2'],
      activeKey: 't1',
    });
    expect(writes[1]?.[0]).toMatchObject({ surface: 'agents', order: ['t2', 't1'] });
  });

  test('after an ABANDONED read, the user reordering the tabs releases suppression and persists the arrangement', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setDockState = vi.fn(() => ({ ok: true as const }));
    const bridge = {
      platform: 'darwin',
      terminal: {
        getDockState: () => new Promise(() => {}),
        setDockState,
      },
      editor: { notifyViewMenuStateChanged: vi.fn() },
    } as unknown as OkDesktopBridge;

    try {
      render(<Harness bridge={bridge} initialVisible />);

      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(
        warnSpy.mock.calls.some((call) =>
          String(call[0]).includes('dock order restore exceeded its 5000ms bound'),
        ),
      ).toBe(true);

      act(() => {
        setOpenThreads([
          makeThread({ threadId: 't1', title: 'One' }),
          makeThread({ threadId: 't2', title: 'Two', createdAt: 2, lastActivityAt: 2 }),
        ]);
      });
      expect(agentsDockWrites(setDockState)).toHaveLength(0);

      focusFirstTab();
      expect(dispatchReorderChord('ArrowRight').defaultPrevented).toBe(true);

      expect(tabTitles()).toEqual(['Two', 'One']);
      const writes = agentsDockWrites(setDockState);
      expect(writes).toHaveLength(2);
      expect(writes[0]?.[0]).toMatchObject({
        surface: 'agents',
        order: ['t1', 't2'],
        activeKey: 't1',
      });
      expect(writes[1]?.[0]).toMatchObject({ surface: 'agents', order: ['t2', 't1'] });
    } finally {
      vi.useRealTimers();
      warnSpy.mockRestore();
    }
  });

  test('after a REJECTED read, a roster arrival withholds but activating a tab releases, and both records reach the log', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setDockState = vi.fn(() => ({ ok: true as const }));
    const bridge = {
      platform: 'darwin',
      terminal: {
        getDockState: () => Promise.reject(new Error('ipc torn down mid-reload')),
        setDockState,
      },
      editor: { notifyViewMenuStateChanged: vi.fn() },
    } as unknown as OkDesktopBridge;

    try {
      render(<Harness bridge={bridge} initialVisible />);
      await act(async () => {});

      act(() => {
        setOpenThreads([makeThread({ threadId: 't1', title: 'One' })]);
      });
      act(() => {
        setOpenThreads([
          makeThread({ threadId: 't1', title: 'One' }),
          makeThread({ threadId: 't2', title: 'Two', createdAt: 2, lastActivityAt: 2 }),
        ]);
      });
      expect(tabTitles()).toEqual(['One', 'Two']);
      expect(agentsDockWrites(setDockState)).toHaveLength(0);
      expect(
        warnSpy.mock.calls.filter((call) =>
          String(call[0]).includes('[agents] dock persistence withheld'),
        ),
      ).toHaveLength(1);
      expect(
        warnSpy.mock.calls.some((call) =>
          String(call[0]).includes('[agents] dock persistence resumed'),
        ),
      ).toBe(false);

      act(() => {
        screen.getByTestId('terminal-new-chat').focus();
      });
      await act(async () => {});
      expect(agentsDockWrites(setDockState)).toHaveLength(0);

      expect(dispatchTabChord('1').defaultPrevented).toBe(true);
      await act(async () => {});

      const writes = agentsDockWrites(setDockState);
      expect(writes.length).toBeGreaterThan(0);
      expect(writes.at(-1)?.[0]).toMatchObject({
        surface: 'agents',
        order: ['t1', 't2'],
        activeKey: 't1',
      });
      expect(
        warnSpy.mock.calls.filter((call) =>
          String(call[0]).includes(
            '[agents] dock persistence resumed: a user arrangement established the tab set the restore did not',
          ),
        ),
      ).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('re-activating the tab already active does not release suppression', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setDockState = vi.fn(() => ({ ok: true as const }));
    const bridge = {
      platform: 'darwin',
      terminal: {
        getDockState: () => Promise.reject(new Error('ipc torn down mid-reload')),
        setDockState,
      },
      editor: { notifyViewMenuStateChanged: vi.fn() },
    } as unknown as OkDesktopBridge;

    try {
      render(<Harness bridge={bridge} initialVisible />);
      await act(async () => {});

      act(() => {
        setOpenThreads([makeThread({ threadId: 't1', title: 'One' })]);
      });
      act(() => {
        setOpenThreads([
          makeThread({ threadId: 't1', title: 'One' }),
          makeThread({ threadId: 't2', title: 'Two', createdAt: 2, lastActivityAt: 2 }),
        ]);
      });
      expect(tabTitles()).toEqual(['One', 'Two']);
      expect(agentsDockWrites(setDockState)).toHaveLength(0);

      act(() => {
        screen.getByTestId('terminal-new-chat').focus();
      });
      await act(async () => {});

      expect(dispatchTabChord('2').defaultPrevented).toBe(true);
      await act(async () => {});

      expect(agentsDockWrites(setDockState)).toHaveLength(0);
      expect(
        warnSpy.mock.calls.some((call) =>
          String(call[0]).includes('[agents] dock persistence resumed'),
        ),
      ).toBe(false);

      expect(dispatchTabChord('1').defaultPrevented).toBe(true);
      await act(async () => {});
      expect(agentsDockWrites(setDockState).length).toBeGreaterThan(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('roster churn alone never releases suppression: only a user gesture does', async () => {
    const setDockState = vi.fn(() => ({ ok: true as const }));
    const bridge = {
      platform: 'darwin',
      terminal: {
        getDockState: () => Promise.reject(new Error('ipc torn down mid-reload')),
        setDockState,
      },
      editor: { notifyViewMenuStateChanged: vi.fn() },
    } as unknown as OkDesktopBridge;

    render(<Harness bridge={bridge} initialVisible />);
    await act(async () => {});

    act(() => {
      setOpenThreads([makeThread({ threadId: 't1', title: 'One' })]);
    });
    expect(agentsDockWrites(setDockState)).toHaveLength(0);

    act(() => {
      setOpenThreads([
        makeThread({ threadId: 't1', title: 'One' }),
        makeThread({ threadId: 't2', title: 'Two', createdAt: 2, lastActivityAt: 2 }),
      ]);
    });
    expect(agentsDockWrites(setDockState)).toHaveLength(0);

    act(() => {
      setOpenThreads([
        makeThread({ threadId: 't2', title: 'Two', createdAt: 2, lastActivityAt: 2 }),
      ]);
    });
    expect(agentsDockWrites(setDockState)).toHaveLength(0);
  });
});

describe('SessionsHost — agents panel (web / no bridge)', () => {
  beforeEach(() => {
    openThreads = [];
    archivedThreads = [];
    agentThreads = [];
    connectionStatus = 'open';
    threadViewHeld = false;
    threadComposerDisabled = false;
    renderThreadView.mockClear();
    closeThread.mockClear();
    renameThread.mockClear();
    openArchivedThread.mockClear();
    deleteThread.mockClear();
    markThreadViewed.mockClear();
    launchAgentThread.mockClear();
    mockLaunchOutcome = 'started';
    toastError.mockClear();
    mockInflightLaunch = false;
    registerAgent.mockClear();
    catalogData = undefined;
    catalogLoading = false;
    catalogError = null;
    refetchCatalog.mockClear();
    mockRegisteredAgent = null;
    mockPersistedDefaultAgent = null;
    initialRosterIds = null;
    localStorage.clear();
    reloadEnabledAgentsFromStorage();
  });
  afterEach(() => {
    cleanup();
    _resetReusableSession();
    vi.restoreAllMocks();
  });

  test('a thread-launch intent carrying an image attachment forwards it to launchAgentThread', async () => {
    render(
      <Harness
        threadLaunch={
          {
            agentSource: 'registry',
            agentId: 'acme-agent',
            prompt: 'describe the screenshot',
            docName: null,
            titleHint: null,
            nonce: 7,
            attachments: [
              {
                kind: 'image',
                mimeType: 'image/png',
                data: 'iVBORw==',
                name: 'drop-me.png',
                sizeBytes: 4,
              },
            ],
          } as ThreadLaunchIntent
        }
      />,
    );

    await waitFor(() => expect(launchAgentThread).toHaveBeenCalledTimes(1));
    expect(collectImageParts(launchAgentThread.mock.calls[0])).toContainEqual(
      expect.objectContaining({ kind: 'image', mimeType: 'image/png', data: 'iVBORw==' }),
    );
  });

  test('a server thread becomes a tab rendering its ThreadView', async () => {
    render(<Harness />);
    setOpenThreads([makeThread({ threadId: 't1', title: 'Refactor' })]);

    expect(await screen.findByRole('tab', { name: /Refactor/ })).toBeDefined();
    expect(await screen.findByTestId('thread-view')).toBeDefined();
  });

  test('history stays reachable for live chats and reflects the active conversation', async () => {
    const user = userEvent.setup();
    setOpenThreads([
      makeThread({
        threadId: 'live',
        title: 'Active work',
        agent: FIRST_AGENT,
        status: 'ready',
      }),
    ]);
    render(<Harness />);
    await screen.findByRole('tab', { name: /Active work/ });

    await user.click(screen.getByRole('button', { name: 'Chat history' }));

    const row = screen.getByTestId('agent-thread-history-open-live');
    expect(row.getAttribute('aria-current')).toBe('true');
    expect(row.textContent).not.toContain('First Agent');
    expect(row.textContent).not.toContain('Ready');
  });

  test('covers the full narrow chat pane and restores focus on Escape', async () => {
    const user = userEvent.setup();
    setOpenThreads([makeThread({ threadId: 'live', title: 'Live conversation' })]);

    render(<Harness />);
    await screen.findByRole('tab', { name: /Live conversation/ });
    const historyToggle = screen.getByRole('button', { name: 'Chat history' });
    await user.click(historyToggle);

    const historyPanel = await screen.findByTestId('agent-thread-history-panel');
    expect(historyPanel.getAttribute('data-history-mode')).toBe('cover');
    const sessionSurface = screen.getByTestId('agent-panel-session-surface');
    const panelLayout = screen.getByTestId('agent-panel-layout');
    expect(sessionSurface.hasAttribute('inert')).toBe(true);
    expect(screen.getByTestId('agent-thread-history-surface').parentElement).toBe(panelLayout);
    expect(screen.getByRole('tab', { name: /Live conversation/ })).toBeDefined();

    await user.keyboard('{Escape}');

    expect(screen.queryByTestId('agent-thread-history-panel')).toBeNull();
    expect(sessionSurface.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(historyToggle);
  });

  test('docks history in a wide chat pane and keeps it open after selection', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ width: 700, height: 600 }),
    );
    const user = userEvent.setup();
    setOpenThreads([
      makeThread({ threadId: 'alpha', title: 'Alpha' }),
      makeThread({ threadId: 'beta', title: 'Beta' }),
    ]);

    render(<Harness />);
    await screen.findByRole('tab', { name: /Alpha/ });
    await user.click(screen.getByRole('button', { name: 'Chat history' }));

    const historyPanel = await screen.findByTestId('agent-thread-history-panel');
    expect(historyPanel.getAttribute('data-history-mode')).toBe('docked');
    expect(screen.getByTestId('agent-panel-session-surface').hasAttribute('inert')).toBe(false);
    const panelLayout = screen.getByTestId('agent-panel-layout');
    expect(screen.getByTestId('agent-panel-session-surface').parentElement).toBe(panelLayout);
    expect(screen.getByTestId('agent-thread-history-surface').parentElement).toBe(panelLayout);

    await user.click(screen.getByTestId('agent-thread-history-open-beta'));

    expect(screen.getByTestId('agent-thread-history-panel')).toBe(historyPanel);
    expect(screen.getByRole('tab', { name: /Beta/ }).getAttribute('aria-selected')).toBe('true');
  });

  test('keeps history search updates out of mounted chat transcripts', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ width: 700, height: 600 }),
    );
    const user = userEvent.setup();
    setOpenThreads([
      makeThread({ threadId: 'alpha', title: 'Alpha' }),
      makeThread({ threadId: 'beta', title: 'Beta' }),
      makeThread({ threadId: 'gamma', title: 'Gamma' }),
    ]);
    render(<Harness />);
    await screen.findByRole('tab', { name: /Alpha/ });
    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    renderThreadView.mockClear();

    await user.type(screen.getByRole('searchbox', { name: 'Search chat history' }), 'xyz');

    expect(renderThreadView).not.toHaveBeenCalled();
  });

  test('closes docked history before shrinking the active chat', async () => {
    let paneWidth = 700;
    let notifyResize = () => {};
    const originalResizeObserver = globalThis.ResizeObserver;
    class ControlledResizeObserver {
      readonly callback: ResizeObserverCallback;

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe(target: Element) {
        if ((target as HTMLElement).dataset.testid !== 'dock-container') return;
        notifyResize = () => this.callback([], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = ControlledResizeObserver as unknown as typeof ResizeObserver;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() =>
      DOMRect.fromRect({ width: paneWidth, height: 600 }),
    );

    try {
      const user = userEvent.setup();
      setOpenThreads([
        makeThread({ threadId: 'alpha', title: 'Alpha planning' }),
        makeThread({ threadId: 'beta', title: 'Beta review' }),
      ]);
      render(<Harness />);
      await screen.findByRole('tab', { name: /Alpha planning/ });
      await user.click(screen.getByRole('button', { name: 'Chat history' }));
      await user.type(screen.getByRole('searchbox', { name: 'Search chat history' }), 'Alpha');

      act(() => {
        paneWidth = 500;
        notifyResize();
      });

      await waitFor(() => expect(screen.queryByTestId('agent-thread-history-panel')).toBeNull());
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Chat history' }));
      expect(screen.getByTestId('agent-panel-session-surface').hasAttribute('inert')).toBe(false);
      expect(screen.getByRole('tab', { name: /Beta review/ }).getAttribute('aria-selected')).toBe(
        'true',
      );

      act(() => {
        paneWidth = 700;
        notifyResize();
      });
      await user.click(screen.getByRole('button', { name: 'Chat history' }));
      const betaTab = screen.getByRole('tab', { name: /Beta review/ });
      act(() => betaTab.focus());
      expect(document.activeElement).toBe(betaTab);

      act(() => {
        paneWidth = 500;
        notifyResize();
      });

      await waitFor(() => expect(screen.queryByTestId('agent-thread-history-panel')).toBeNull());
      expect(document.activeElement).toBe(betaTab);

      await user.click(screen.getByRole('button', { name: 'Chat history' }));
      expect(screen.getByTestId('agent-thread-history-panel').dataset.historyMode).toBe('cover');
      act(() => {
        paneWidth = 700;
        notifyResize();
      });

      await waitFor(() =>
        expect(screen.getByTestId('agent-thread-history-panel').dataset.historyMode).toBe('docked'),
      );
      expect(
        screen.getByRole('searchbox', { name: 'Search chat history' }).getAttribute('value'),
      ).toBe('Alpha');
      expect(screen.getByRole('tab', { name: /Beta review/ }).getAttribute('aria-selected')).toBe(
        'true',
      );
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  test('does not reopen history when the hidden agents pane is revealed', async () => {
    const control = makeControl();
    const user = userEvent.setup();
    setOpenThreads([makeThread({ threadId: 'alpha', title: 'Alpha planning' })]);
    render(<Harness control={control} />);
    await screen.findByRole('tab', { name: /Alpha planning/ });
    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    expect(screen.getByTestId('agent-thread-history-panel')).toBeDefined();

    act(() => control.current?.setVisible(false));
    await waitFor(() => expect(screen.queryByTestId('agent-thread-history-panel')).toBeNull());
    act(() => control.current?.setVisible(true));

    expect(screen.queryByTestId('agent-thread-history-panel')).toBeNull();
  });

  test('does not mark covered transcript activity viewed until history closes', async () => {
    const user = userEvent.setup();
    setOpenThreads([makeThread({ threadId: 'live', title: 'Live', lastActivityAt: 1 })]);

    render(<Harness />);
    await screen.findByRole('tab', { name: /Live/ });
    await waitFor(() => expect(markThreadViewed).toHaveBeenCalledWith('live'));
    markThreadViewed.mockClear();

    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    act(() => {
      setOpenThreads([makeThread({ threadId: 'live', title: 'Live', lastActivityAt: 2 })]);
    });

    expect(markThreadViewed).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Chat history' }));

    await waitFor(() => expect(markThreadViewed).toHaveBeenCalledWith('live'));
  });

  test('launches New chat from history through the existing launcher and dismisses cover', async () => {
    mockRegisteredAgent = FIRST_AGENT;
    mockPersistedDefaultAgent = FIRST_AGENT;
    setOpenThreads([makeThread({ threadId: 'live', title: 'Live' })]);
    const user = userEvent.setup();
    render(<Harness />);
    await screen.findByRole('tab', { name: /Live/ });
    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    const historyPanel = screen.getByTestId('agent-thread-history-panel');
    const newChat = within(historyPanel).getByTestId('terminal-new-chat');

    expect(newChat.textContent).toContain('New chat');
    await user.click(newChat);

    expect(launchAgentThread).toHaveBeenCalledWith(
      { source: FIRST_AGENT.source, id: FIRST_AGENT.id },
      null,
      null,
      null,
      null,
      undefined,
    );
    expect(screen.queryByTestId('agent-thread-history-panel')).toBeNull();
  });

  test('history search survives toggles and clears when the thread project scope changes', async () => {
    const user = userEvent.setup();
    setOpenThreads([
      makeThread({ threadId: 'alpha', title: 'Alpha plan' }),
      makeThread({ threadId: 'beta', title: 'Beta plan' }),
    ]);
    render(<Harness />);
    await screen.findByRole('tab', { name: /Alpha plan/ });

    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search chat history' }), 'Alpha');
    expect(screen.queryByTestId('agent-thread-history-open-beta')).toBeNull();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    expect(
      (screen.getByRole('searchbox', { name: 'Search chat history' }) as HTMLInputElement).value,
    ).toBe('Alpha');

    act(() => setThreadScope('ws://project-b/collab/thread'));

    expect(
      (screen.getByRole('searchbox', { name: 'Search chat history' }) as HTMLInputElement).value,
    ).toBe('');
    expect(screen.getByTestId('agent-thread-history-open-beta')).toBeDefined();
  });

  test('empty history remains reachable and explains the empty collection', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Chat history' }));

    expect(screen.getByRole('heading', { name: 'No chats yet.' })).toBeDefined();
  });

  test('history and tabs share selection without reordering or lifecycle operations', async () => {
    const user = userEvent.setup();
    setOpenThreads([
      makeThread({ threadId: 'a', title: 'Alpha', agent: FIRST_AGENT }),
      makeThread({ threadId: 'b', title: 'Beta', agent: SECOND_AGENT }),
    ]);
    render(<Harness />);
    const alphaTab = await screen.findByRole('tab', { name: /Alpha/ });
    const betaTab = await screen.findByRole('tab', { name: /Beta/ });
    const initialOrder = tabTitles();

    await user.click(alphaTab);
    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    expect(screen.getByTestId('agent-thread-history-open-a').getAttribute('aria-current')).toBe(
      'true',
    );
    await user.click(screen.getByTestId('agent-thread-history-open-b'));
    expect(betaTab.getAttribute('aria-selected')).toBe('true');

    await user.click(alphaTab);
    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    expect(screen.getByTestId('agent-thread-history-open-a').getAttribute('aria-current')).toBe(
      'true',
    );
    expect(tabTitles()).toEqual(initialOrder);
    expect(openArchivedThread).not.toHaveBeenCalled();
    expect(closeThread).not.toHaveBeenCalled();
    expect(deleteThread).not.toHaveBeenCalled();
  });

  test('history switching preserves the mounted conversation views and draft input', async () => {
    const user = userEvent.setup();
    setOpenThreads([
      makeThread({ threadId: 'a', title: 'Alpha' }),
      makeThread({ threadId: 'b', title: 'Beta' }),
    ]);
    render(<Harness />);
    const alphaTab = await screen.findByRole('tab', { name: /Alpha/ });
    await screen.findByRole('tab', { name: /Beta/ });
    await user.click(alphaTab);
    const alphaView = document.querySelector<HTMLElement>('[data-thread-id="a"]');
    const alphaComposer = alphaView?.querySelector<HTMLTextAreaElement>(
      '[data-testid="agent-thread-composer"]',
    );
    expect(alphaView).not.toBeNull();
    expect(alphaComposer).not.toBeNull();
    await user.type(alphaComposer as HTMLTextAreaElement, 'unfinished thought');

    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    await user.click(screen.getByTestId('agent-thread-history-open-b'));
    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    await user.click(screen.getByTestId('agent-thread-history-open-a'));

    expect(document.querySelector('[data-thread-id="a"]')).toBe(alphaView);
    expect(alphaComposer?.value).toBe('unfinished thought');
    expect(lastThreadViewActive('a')).toBe(true);
    expect(lastThreadViewActive('b')).toBe(false);
  });

  test('Ask AI and queued comments target the conversation selected from history', async () => {
    const user = userEvent.setup();
    setOpenThreads([
      makeThread({ threadId: 'a', title: 'Alpha' }),
      makeThread({ threadId: 'b', title: 'Beta' }),
    ]);
    render(<Harness />);
    await screen.findByRole('tab', { name: /Alpha/ });
    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    await user.click(screen.getByTestId('agent-thread-history-open-b'));

    const staged: string[] = [];
    const queued: Array<{ threadId: string; threadIds: readonly string[] | undefined }> = [];
    const stopStaging = subscribeStagedThreadDraft('b', (text) => staged.push(text));
    const stopQueued = subscribeSendInThread((threadId, threadIds) =>
      queued.push({ threadId, threadIds }),
    );
    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    await act(async () => {
      requestActiveTerminalInput('Use this selection', { submit: false });
    });
    expect(screen.queryByTestId('agent-thread-history-panel')).toBeNull();
    expect(document.activeElement).toBe(
      document
        .querySelector('[data-thread-id="b"]')
        ?.querySelector('[data-testid="agent-thread-composer"]'),
    );

    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    await act(async () => {
      requestSendToOpenChat(['comment-1']);
    });
    expect(screen.queryByTestId('agent-thread-history-panel')).toBeNull();
    stopStaging();
    stopQueued();

    expect(staged).toEqual(['Use this selection']);
    expect(queued).toEqual([{ threadId: 'b', threadIds: ['comment-1'] }]);
  });

  test('without an explicit default the primary reads "Start an agent" and opens Settings', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const button = await screen.findByTestId('terminal-new-chat');
    expect(button.getAttribute('aria-label')).toBe('Start an agent');
    await user.click(button);

    expect(launchAgentThread).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#settings/agent-connections');
  });

  test('the tab list mirrors the store: add + remove', async () => {
    render(<Harness />);
    setOpenThreads([makeThread({ threadId: 't1', title: 'One' })]);
    await screen.findByRole('tab', { name: /One/ });

    setOpenThreads([
      makeThread({ threadId: 't1', title: 'One' }),
      makeThread({ threadId: 't2', title: 'Two' }),
    ]);
    await screen.findByRole('tab', { name: /Two/ });

    setOpenThreads([makeThread({ threadId: 't2', title: 'Two' })]);
    await waitFor(() => expect(screen.queryByRole('tab', { name: /One/ })).toBeNull());
    expect(screen.getByRole('tab', { name: /Two/ })).toBeDefined();
  });

  test('the appendable-session signal names the ACTIVE tab, not the previous one', async () => {
    render(<Harness />);
    setOpenThreads([makeThread({ threadId: 't1', title: 'One', agent: FIRST_AGENT })]);
    await screen.findByRole('tab', { name: /One/ });
    await waitFor(() => expect(getReusableSession()?.label).toBe('First Agent'));

    setOpenThreads([
      makeThread({ threadId: 't1', title: 'One', agent: FIRST_AGENT }),
      makeThread({ threadId: 't2', title: 'Two', agent: SECOND_AGENT }),
    ]);
    await screen.findByRole('tab', { name: /Two/ });

    await waitFor(() => expect(getReusableSession()?.label).toBe('Second Agent'));
    expect(getReusableSession()).toMatchObject({ id: 't2', kind: 'thread', agentId: 'a2' });
  });

  test('closing a thread tab archives it via the client (not a local remove)', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    setOpenThreads([makeThread({ threadId: 't1', title: 'Doomed' })]);
    await screen.findByRole('tab', { name: /Doomed/ });

    await user.click(screen.getByRole('button', { name: 'Close Doomed' }));

    expect(closeThread).toHaveBeenCalledTimes(1);
    expect(closeThread).toHaveBeenCalledWith('t1');
  });

  test('renaming a thread tab routes to the server rename', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    setOpenThreads([makeThread({ threadId: 't1', title: 'Old name' })]);
    await screen.findByRole('tab', { name: /Old name/ });

    await user.dblClick(screen.getByRole('tab', { name: /Old name/ }));
    const input = screen.getByRole('textbox', { name: /Rename/ });
    await user.clear(input);
    await user.type(input, 'New name');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(renameThread).toHaveBeenCalledWith('t1', 'New name'));
  });

  test('a newly live thread reveals a hidden dock (auto-reveal)', async () => {
    const onVisibleChange = vi.fn((_v: boolean) => {});
    render(<Harness initialVisible={false} onVisibleChange={onVisibleChange} />);

    setOpenThreads([makeThread({ threadId: 't1', title: 'Fresh' })]);

    await waitFor(() => expect(onVisibleChange).toHaveBeenCalledWith(true));
  });

  test('an archived-only backlog does NOT auto-reveal the dock', async () => {
    const onVisibleChange = vi.fn((_v: boolean) => {});
    render(<Harness initialVisible={false} onVisibleChange={onVisibleChange} />);

    setOpenThreads([makeThread({ threadId: 't1', title: 'History', archived: true })]);

    await new Promise((r) => setTimeout(r, 50));
    expect(onVisibleChange).not.toHaveBeenCalled();
  });

  test('a live thread already in the roster at first render does NOT auto-reveal the dock', async () => {
    const onVisibleChange = vi.fn((_v: boolean) => {});
    setOpenThreads([makeThread({ threadId: 't1', title: 'Pre-existing' })]);

    render(<Harness initialVisible={false} onVisibleChange={onVisibleChange} />);
    await screen.findByRole('tab', { name: /Pre-existing/ });

    expect(onVisibleChange).not.toHaveBeenCalled();
  });

  test('revealing the dock focuses the active session', async () => {
    const control = makeControl();
    setOpenThreads([makeThread({ threadId: 't1', title: 'Pre-existing' })]);
    render(<Harness initialVisible={false} control={control} />);
    await screen.findByTestId('thread-view');
    act(() => {
      (document.activeElement as HTMLElement | null)?.blur?.();
    });
    expect(document.activeElement).not.toBe(screen.getByTestId('agent-thread-composer'));

    act(() => {
      control.current?.setVisible(true);
    });

    expect(document.activeElement).toBe(screen.getByTestId('agent-thread-composer'));
  });

  test('revealing the dock focuses the active tab while its composer is disabled', async () => {
    const control = makeControl();
    threadComposerDisabled = true;
    setOpenThreads([makeThread({ threadId: 't1', title: 'Connecting' })]);
    render(<Harness initialVisible={false} control={control} />);
    await screen.findByTestId('thread-view');

    act(() => {
      control.current?.setVisible(true);
    });

    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /Connecting/ }));
  });

  test('collapsing the dock hands focus back to the editor', async () => {
    const user = userEvent.setup();
    const onVisibleChange = vi.fn((_v: boolean) => {});
    const onRequestEditorFocus = vi.fn(() => {});
    setOpenThreads([makeThread({ threadId: 't1', title: 'Pre-existing' })]);
    render(
      <Harness onVisibleChange={onVisibleChange} onRequestEditorFocus={onRequestEditorFocus} />,
    );
    await screen.findByTestId('thread-view');

    await user.click(screen.getByRole('button', { name: 'Collapse agent panel' }));

    expect(onVisibleChange).toHaveBeenCalledWith(false);
    expect(onRequestEditorFocus).toHaveBeenCalled();
  });

  test('revealing the dock before the thread view loads focuses the session when it arrives', async () => {
    const control = makeControl();
    threadViewHeld = true;
    setOpenThreads([makeThread({ threadId: 't1', title: 'Pre-existing' })]);
    render(<Harness initialVisible={false} control={control} />);
    await act(async () => {});

    act(() => {
      control.current?.setVisible(true);
    });
    expect(screen.queryByTestId('agent-thread-composer')).toBeNull();

    threadViewHeld = false;
    act(() => {
      control.current?.rerender();
    });

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('agent-thread-composer')),
    );
  });

  test('a late-arriving thread view does not steal focus from elsewhere', async () => {
    const control = makeControl();
    threadViewHeld = true;
    const focusCalls: string[] = [];
    const origFocus = HTMLElement.prototype.focus;
    Object.defineProperty(HTMLElement.prototype, 'focus', {
      value: function focusProbe(this: HTMLElement) {
        focusCalls.push(`${this.tagName}:${this.getAttribute('data-testid') ?? ''}`);
        return origFocus.call(this);
      },
      configurable: true,
      writable: true,
    });
    setOpenThreads([makeThread({ threadId: 't1', title: 'Pre-existing' })]);
    render(<Harness initialVisible={false} control={control} />);
    await act(async () => {});

    act(() => {
      control.current?.setVisible(true);
    });
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);

    threadViewHeld = false;
    act(() => {
      control.current?.rerender();
    });
    await screen.findByTestId('thread-view');

    try {
      expect(document.activeElement).toBe(outside);
    } catch (error) {
      throw new Error(
        `focus calls were: [${focusCalls.join(' | ')}]; underlying: ${String(error)}`,
      );
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'focus', {
        value: origFocus,
        configurable: true,
        writable: true,
      });
      outside.remove();
    }
  });

  test('a late-arriving thread view lands focus on the next mutation after the user defocuses', async () => {
    const control = makeControl();
    threadViewHeld = true;
    setOpenThreads([makeThread({ threadId: 't1', title: 'Pre-existing' })]);
    render(<Harness initialVisible={false} control={control} />);
    await act(async () => {});

    act(() => {
      control.current?.setVisible(true);
    });
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    outside.focus();

    threadViewHeld = false;
    act(() => {
      control.current?.rerender();
    });
    await screen.findByTestId('thread-view');
    expect(document.activeElement).toBe(outside);

    outside.blur();
    threadViewHeld = true;
    act(() => {
      control.current?.rerender();
    });
    threadViewHeld = false;
    act(() => {
      control.current?.rerender();
    });

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('agent-thread-composer')),
    );
    outside.remove();
  });

  test('a reveal that reaches the fallback tab retires without a warning at the deadline', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const control = makeControl();
    threadViewHeld = true;
    setOpenThreads([makeThread({ threadId: 't1', title: 'Pre-existing' })]);
    render(<Harness initialVisible={false} control={control} />);
    await act(async () => {});

    try {
      act(() => {
        control.current?.setVisible(true);
      });
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: /Pre-existing/ }));
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(
        warnSpy.mock.calls.some((call) =>
          String(call[0]).includes('reveal focus did not land within its 5000ms bound'),
        ),
      ).toBe(false);

      threadViewHeld = false;
      await act(async () => {
        control.current?.rerender();
      });
      expect(screen.getByTestId('thread-view')).toBeDefined();
      expect(document.activeElement).not.toBe(screen.getByTestId('agent-thread-composer'));
    } finally {
      vi.useRealTimers();
      warnSpy.mockRestore();
    }
  });

  test('a reveal focus that lands and is then released to body before the deadline does not warn', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const control = makeControl();
    threadViewHeld = true;
    setOpenThreads([makeThread({ threadId: 't1', title: 'Pre-existing' })]);
    render(<Harness initialVisible={false} control={control} />);
    await act(async () => {});

    try {
      act(() => {
        control.current?.setVisible(true);
      });
      threadViewHeld = false;
      act(() => {
        control.current?.rerender();
      });
      await act(async () => {});
      const composer = screen.getByTestId('agent-thread-composer');
      expect(document.activeElement).toBe(composer);

      composer.blur();
      expect(document.activeElement).toBe(document.body);

      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(
        warnSpy.mock.calls.some((call) =>
          String(call[0]).includes('reveal focus did not land within its 5000ms bound'),
        ),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
      warnSpy.mockRestore();
    }
  });
  test('the history menu reopens an archived conversation as a tab', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    setOpenThreads([makeThread({ threadId: 'live', title: 'Live' })]);
    setArchivedThreads([makeThread({ threadId: 'arch', title: 'Old chat', archived: true })]);
    await screen.findByRole('tab', { name: /Live/ });

    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    await user.click(await screen.findByTestId('agent-thread-history-open-arch'));

    expect(openArchivedThread).toHaveBeenCalledWith('arch');
    expect(await screen.findByRole('tab', { name: /Old chat/ })).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    await user.click(await screen.findByTestId('agent-thread-history-open-arch'));
    expect(openArchivedThread).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('tab', { name: /Old chat/ })).toHaveLength(1);
  });

  test('the restore and delete controls explain themselves on hover', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    setOpenThreads([makeThread({ threadId: 'live', title: 'Live' })]);
    setArchivedThreads([makeThread({ threadId: 'arch', title: 'Old chat', archived: true })]);
    await screen.findByRole('tab', { name: /Live/ });

    const restore = screen.getByRole('button', { name: 'Chat history' });
    await user.hover(restore);
    expect((await screen.findByRole('tooltip')).textContent).toContain('Chat history');

    await user.click(restore);
    const deleteButton = await screen.findByRole('button', { name: 'Delete Old chat' });
    await user.hover(deleteButton);
    expect((await screen.findByRole('tooltip')).textContent).toContain('Delete chat');
  });

  test('the history menu deletes an archived conversation after dialog confirmation', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    setOpenThreads([makeThread({ threadId: 'live', title: 'Live' })]);
    setArchivedThreads([makeThread({ threadId: 'arch', title: 'Old chat', archived: true })]);
    await screen.findByRole('tab', { name: /Live/ });

    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    await user.click(await screen.findByTestId('agent-thread-history-delete-arch'));
    expect(deleteThread).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('This action cannot be undone.');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(deleteThread).toHaveBeenCalledWith('arch');
  });

  test('Escape inside the delete confirmation closes the dialog and leaves history open', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    setOpenThreads([makeThread({ threadId: 'live', title: 'Live' })]);
    setArchivedThreads([makeThread({ threadId: 'arch', title: 'Old chat', archived: true })]);
    await screen.findByRole('tab', { name: /Live/ });

    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    await user.click(await screen.findByTestId('agent-thread-history-delete-arch'));
    expect(await screen.findByRole('alertdialog')).toBeDefined();

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByTestId('agent-thread-history-panel')).toBeDefined();
    expect(deleteThread).not.toHaveBeenCalled();
  });

  test('delete is off for an archived conversation that is open as a tab', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const viewed = makeThread({ threadId: 'arch', title: 'Old chat', archived: true });
    setOpenThreads([makeThread({ threadId: 'live', title: 'Live' }), viewed]);
    setArchivedThreads([
      viewed,
      makeThread({ threadId: 'cold', title: 'Cold chat', archived: true }),
    ]);
    await screen.findByRole('tab', { name: /Live/ });

    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    expect(screen.getAllByTestId('agent-thread-history-open-arch')).toHaveLength(1);
    const openTabDelete = await screen.findByTestId('agent-thread-history-delete-arch');
    expect(openTabDelete.getAttribute('aria-disabled')).toBe('true');
    expect(openTabDelete).toHaveProperty('disabled', false);

    openTabDelete.focus();
    expect(document.activeElement).toBe(openTabDelete);

    await user.hover(openTabDelete);
    expect((await screen.findByRole('tooltip')).textContent).toContain(
      "Close this chat's tab to delete it",
    );
    const describedBy = openTabDelete.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy ?? '')?.textContent).toContain(
      "Close this chat's tab to delete it",
    );

    await user.click(openTabDelete);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(deleteThread).not.toHaveBeenCalled();

    expect(screen.getByTestId('agent-thread-history-open-arch')).toHaveProperty('disabled', false);

    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Close Old chat' }));
    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    const eligibleDelete = await screen.findByTestId('agent-thread-history-delete-arch');
    expect(eligibleDelete.getAttribute('aria-disabled')).toBeNull();
  });

  test('an archived conversation with no open tab is still deletable', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    setOpenThreads([makeThread({ threadId: 'live', title: 'Live' })]);
    setArchivedThreads([makeThread({ threadId: 'cold', title: 'Cold chat', archived: true })]);
    await screen.findByRole('tab', { name: /Live/ });

    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    const coldDelete = await screen.findByTestId('agent-thread-history-delete-cold');
    expect(coldDelete.getAttribute('aria-disabled')).toBeNull();
    expect(coldDelete.getAttribute('aria-describedby')).toBeNull();

    await user.click(coldDelete);
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    );
    expect(deleteThread).toHaveBeenCalledWith('cold');
  });

  test('an empty dock uses history as its only archived conversation roster', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    setArchivedThreads([makeThread({ threadId: 'arch', title: 'Yesterday', archived: true })]);

    expect(screen.queryByTestId('agent-thread-empty-chooser')).toBeNull();
    expect(await screen.findByTestId('sessions-dock-empty')).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    await user.click(await screen.findByTestId('agent-thread-history-open-arch'));

    expect(openArchivedThread).toHaveBeenCalledWith('arch');
    expect(await screen.findByRole('tab', { name: /Yesterday/ })).toBeDefined();
  });

  test('the history menu remains available without archived history', () => {
    render(<Harness />);
    setOpenThreads([makeThread({ threadId: 'live', title: 'Live' })]);
    expect(screen.getByRole('button', { name: 'Chat history' })).toBeDefined();
  });

  describe('Ask AI honors the preferred AI', () => {
    test('an Ask AI instruction RUNS on a new thread (never a CLI)', async () => {
      mockRegisteredAgent = { source: 'registry', id: 'acme-agent', name: 'Acme' };
      const launches: unknown[] = [];
      const stopLaunch = subscribeToTerminalLaunchRequests((prompt, cli, opts) =>
        launches.push({ prompt, cli, ...opts }),
      );
      render(<Harness />);
      await screen.findByTestId('terminal-new-chat');

      await act(async () => {
        requestActiveTerminalInput('fix this lint error', { submit: true });
      });
      stopLaunch();

      expect(launchAgentThread).toHaveBeenCalledTimes(1);
      const [agent, prompt, , , stagedDraft] = launchAgentThread.mock.calls[0];
      expect(agent).toEqual({ source: 'registry', id: 'acme-agent' });
      expect(prompt).toBe('fix this lint error');
      expect(stagedDraft).toBeNull();
      expect(launches).toEqual([]);
    });

    test('a deduped Ask AI launch reports that the prompt was not sent', async () => {
      mockRegisteredAgent = { source: 'registry', id: 'acme-agent', name: 'Acme' };
      mockLaunchOutcome = 'deduped';
      setInitialRosterIds(new Set());
      render(<Harness initialVisible={false} />);

      await act(async () => {
        requestActiveTerminalInput('fix this lint error', { submit: true, target: 'agents' });
      });

      expect(toastError).toHaveBeenCalledTimes(1);
      expect(screen.queryByText("Couldn't start the agent thread.")).toBeNull();
      expect(
        screen.getByText('Already starting a chat with this agent — try again in a moment.'),
      ).toBeDefined();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined();
      expect(screen.queryByText('Starting the agent…')).toBeNull();
    });

    test('a deduped launch does not hide the tracked launch failure', async () => {
      mockRegisteredAgent = { source: 'registry', id: 'acme-agent', name: 'Acme' };
      setInitialRosterIds(new Set());
      let settleTrackedLaunch: (outcome: 'failed') => void = () => {};
      launchAgentThread
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              settleTrackedLaunch = resolve;
            }),
        )
        .mockResolvedValueOnce('deduped');
      render(<Harness initialVisible />);
      await waitFor(() => expect(launchAgentThread).toHaveBeenCalledTimes(1));

      await act(async () => {
        requestActiveTerminalInput('fix this lint error', { submit: true, target: 'agents' });
      });

      expect(toastError).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Starting the agent…')).toBeDefined();

      await act(async () => settleTrackedLaunch('failed'));

      expect(await screen.findByText("Couldn't start the agent thread.")).toBeDefined();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined();
    });

    test('a ⌘J selection send STAGES on a new thread instead of running', async () => {
      mockRegisteredAgent = { source: 'registry', id: 'acme-agent', name: 'Acme' };
      render(<Harness />);
      await screen.findByTestId('terminal-new-chat');

      await act(async () => {
        requestActiveTerminalInput('a selected passage', { submit: false });
      });

      expect(launchAgentThread).toHaveBeenCalledTimes(1);
      const [, prompt, , , stagedDraft] = launchAgentThread.mock.calls[0];
      expect(prompt).toBeNull();
      expect(stagedDraft).toBe('a selected passage');
    });

    test('a failed Ask AI launch in an empty hidden panel offers a retry', async () => {
      mockRegisteredAgent = { source: 'registry', id: 'acme-agent', name: 'Acme' };
      mockLaunchOutcome = 'failed';
      setInitialRosterIds(new Set());
      render(<Harness initialVisible={false} />);

      await act(async () => {
        requestActiveTerminalInput('fix this lint error', { submit: true, target: 'agents' });
      });

      expect(await screen.findByText("Couldn't start the agent thread.")).toBeDefined();
      mockLaunchOutcome = 'started';
      await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

      expect(launchAgentThread).toHaveBeenCalledTimes(2);
      expect(launchAgentThread.mock.calls[1]).toEqual([
        { source: 'registry', id: 'acme-agent' },
        'fix this lint error',
        null,
        null,
        null,
        undefined,
      ]);
    });

    test.each([true, false])('reusing an open thread always stages, submit=%s', async (submit) => {
      mockRegisteredAgent = { source: 'registry', id: 'acme-agent', name: 'Acme' };
      render(<Harness />);
      setOpenThreads([makeThread({ threadId: 't1', title: 'Work' })]);
      await screen.findByTestId('thread-view');

      const staged: string[] = [];
      const stopStaging = subscribeStagedThreadDraft('t1', (text) => staged.push(text));
      await act(async () => {
        requestActiveTerminalInput('fix this lint error', { submit });
      });
      stopStaging();

      expect(staged).toEqual(['fix this lint error']);
      expect(launchAgentThread).not.toHaveBeenCalled();
    });

    test('reusing a thread reveals a collapsed dock', async () => {
      mockRegisteredAgent = { source: 'registry', id: 'acme-agent', name: 'Acme' };
      setOpenThreads([makeThread({ threadId: 't1', title: 'Work' })]);
      const onVisibleChange = vi.fn((_v: boolean) => {});
      render(<Harness initialVisible={false} onVisibleChange={onVisibleChange} />);
      await screen.findByTestId('thread-view');
      expect(onVisibleChange).not.toHaveBeenCalled();

      const staged: string[] = [];
      const stopStaging = subscribeStagedThreadDraft('t1', (text) => staged.push(text));
      await act(async () => {
        requestActiveTerminalInput('fix this lint error', { submit: false });
      });
      stopStaging();

      expect(staged).toEqual(['fix this lint error']);
      expect(onVisibleChange).toHaveBeenCalledWith(true);
    });

    test('newTab forces a fresh thread even with one open (⇧⌘J)', async () => {
      mockRegisteredAgent = { source: 'registry', id: 'acme-agent', name: 'Acme' };
      render(<Harness />);
      setOpenThreads([makeThread({ threadId: 't1', title: 'Work' })]);
      await screen.findByTestId('thread-view');

      const staged: string[] = [];
      const stopStaging = subscribeStagedThreadDraft('t1', (text) => staged.push(text));
      await act(async () => {
        requestActiveTerminalInput('a fresh question', { newTab: true, submit: false });
      });
      stopStaging();

      expect(staged).toEqual([]);
      expect(launchAgentThread).toHaveBeenCalledTimes(1);
      const [, prompt, , , stagedDraft] = launchAgentThread.mock.calls[0];
      expect(prompt).toBeNull();
      expect(stagedDraft).toBe('a fresh question');
    });

    test('newTab with submit runs the instruction in a fresh thread', async () => {
      mockRegisteredAgent = { source: 'registry', id: 'acme-agent', name: 'Acme' };
      render(<Harness />);
      setOpenThreads([makeThread({ threadId: 't1', title: 'Work' })]);
      await screen.findByTestId('thread-view');

      const staged: string[] = [];
      const stopStaging = subscribeStagedThreadDraft('t1', (text) => staged.push(text));
      await act(async () => {
        requestActiveTerminalInput('fix this lint error', { newTab: true, submit: true });
      });
      stopStaging();

      expect(staged).toEqual([]);
      expect(launchAgentThread).toHaveBeenCalledTimes(1);
      const [, prompt, , , stagedDraft] = launchAgentThread.mock.calls[0];
      expect(prompt).toBe('fix this lint error');
      expect(stagedDraft).toBeNull();
    });

    test('a promptless preferred-session request opens a thread when an agent is preferred', async () => {
      mockRegisteredAgent = { source: 'registry', id: 'acme-agent', name: 'Acme' };
      render(<Harness />);
      await screen.findByTestId('terminal-new-chat');

      await act(async () => {
        requestPreferredSession();
      });

      expect(launchAgentThread).toHaveBeenCalledTimes(1);
      expect(launchAgentThread.mock.calls[0][0]).toEqual({ source: 'registry', id: 'acme-agent' });
    });

    test('a promptless preferred-session request is left to the terminal dock with no agent', async () => {
      render(<Harness bridge={makeTerminalBridge()} />);
      await screen.findByTestId('terminal-new-chat');

      await act(async () => {
        requestPreferredSession();
      });

      expect(launchAgentThread).not.toHaveBeenCalled();
    });

    test.each([
      { submit: true, label: 'an Ask AI instruction' },
      { submit: false, label: 'a selection send' },
    ])('with NO agent set up, $label is left to the terminal dock', async ({ submit }) => {
      const launches: unknown[] = [];
      const stopLaunch = subscribeToTerminalLaunchRequests((prompt, cli, opts) =>
        launches.push({ prompt, cli, ...opts }),
      );
      const onVisibleChange = vi.fn((_v: boolean) => {});
      render(<Harness bridge={makeTerminalBridge()} onVisibleChange={onVisibleChange} />);
      await screen.findByTestId('terminal-new-chat');

      await act(async () => {
        requestActiveTerminalInput('fix this lint error', { submit });
      });
      stopLaunch();

      expect(launchAgentThread).not.toHaveBeenCalled();
      expect(launches).toEqual([]);
      expect(onVisibleChange).not.toHaveBeenCalled();
    });

    test('with nothing set up, an Ask AI send opens Configure agents (no silent shell)', async () => {
      window.location.hash = '';
      render(<Harness />);
      await screen.findByTestId('terminal-new-chat');

      await act(async () => {
        requestActiveTerminalInput('fix this lint error', { submit: false });
      });

      expect(launchAgentThread).not.toHaveBeenCalled();
      expect(window.location.hash).toBe('#settings/agent-connections');
    });
  });

  describe('pickerless thread launch', () => {
    const sentinelLaunch = (nonce: number): ThreadLaunchIntent => ({
      agentSource: 'registry',
      agentId: '',
      prompt: null,
      docName: null,
      titleHint: null,
      attachments: null,
      nonce,
    });

    test('with no persisted default it starts the effective default agent, not Settings', () => {
      window.location.hash = '';
      mockRegisteredAgent = { source: 'registry', id: 'claude-acp', name: 'Claude Agent' };
      render(<Harness threadLaunch={sentinelLaunch(1)} />);

      expect(launchAgentThread).toHaveBeenCalledTimes(1);
      expect(launchAgentThread.mock.calls[0]).toEqual([
        { source: 'registry', id: 'claude-acp' },
        null,
        null,
        null,
        null,
        undefined,
      ]);
      expect(window.location.hash).toBe('');
      expect(registerAgent).not.toHaveBeenCalled();
    });

    test('with nothing enabled it still opens Configure agents', () => {
      window.location.hash = '';
      mockRegisteredAgent = null;
      render(<Harness threadLaunch={sentinelLaunch(1)} />);

      expect(launchAgentThread).not.toHaveBeenCalled();
      expect(window.location.hash).toBe('#settings/agent-connections');
    });

    test('an agent the user disabled is never what a pickerless launch leads with', () => {
      window.location.hash = '';
      mockRegisteredAgent = { source: 'registry', id: 'claude-acp', name: 'Claude Agent' };
      setAgentEnabled(inAppEnabledKey('registry', 'claude-acp'), false);
      render(<Harness threadLaunch={sentinelLaunch(1)} />);

      expect(launchAgentThread).not.toHaveBeenCalled();
      expect(window.location.hash).toBe('#settings/agent-connections');
    });

    test('an agent with no launchable build on this host is not what a launch leads with', () => {
      window.location.hash = '';
      mockRegisteredAgent = {
        source: 'registry',
        id: 'claude-acp',
        name: 'Claude Agent',
        supported: false,
      };
      render(<Harness threadLaunch={sentinelLaunch(1)} />);

      expect(launchAgentThread).not.toHaveBeenCalled();
      expect(window.location.hash).toBe('#settings/agent-connections');
    });

    test('an explicitly persisted default still wins over the presented agent', () => {
      window.location.hash = '';
      mockRegisteredAgent = { source: 'registry', id: 'claude-acp', name: 'Claude Agent' };
      mockPersistedDefaultAgent = { source: 'registry', id: 'codex-acp', name: 'Codex Agent' };
      render(<Harness threadLaunch={sentinelLaunch(1)} />);

      expect(launchAgentThread).toHaveBeenCalledTimes(1);
      expect(launchAgentThread.mock.calls[0][0]).toEqual({ source: 'registry', id: 'codex-acp' });
      expect(registerAgent).not.toHaveBeenCalled();
    });

    test('an intent that arrives before an agent exists still launches once one does', () => {
      window.location.hash = '';
      mockRegisteredAgent = null;
      const control = makeControl();
      render(<Harness threadLaunch={sentinelLaunch(1)} control={control} />);

      expect(launchAgentThread).not.toHaveBeenCalled();
      expect(window.location.hash).toBe('#settings/agent-connections');

      mockRegisteredAgent = { source: 'registry', id: 'claude-acp', name: 'Claude Agent' };
      act(() => control.current?.rerender());

      expect(launchAgentThread).toHaveBeenCalledTimes(1);
      expect(launchAgentThread.mock.calls[0][0]).toEqual({ source: 'registry', id: 'claude-acp' });
    });

    test('the catalog is offered once, not on every render while the registry settles', () => {
      window.location.hash = '';
      mockRegisteredAgent = null;
      const control = makeControl();
      render(<Harness threadLaunch={sentinelLaunch(1)} control={control} />);
      expect(window.location.hash).toBe('#settings/agent-connections');

      window.location.hash = '#settings/some-other-tab';
      act(() => control.current?.rerender());
      act(() => control.current?.rerender());

      expect(window.location.hash).toBe('#settings/some-other-tab');
      expect(launchAgentThread).not.toHaveBeenCalled();
    });

    test('a launch naming a concrete agent starts that agent, not the default', () => {
      window.location.hash = '';
      mockRegisteredAgent = { source: 'registry', id: 'claude-acp', name: 'Claude Agent' };
      render(
        <Harness
          threadLaunch={{
            agentSource: 'custom',
            agentId: 'my-agent',
            prompt: 'do the thing',
            docName: 'notes',
            titleHint: 'Notes',
            attachments: null,
            nonce: 1,
          }}
        />,
      );

      expect(launchAgentThread).toHaveBeenCalledTimes(1);
      expect(launchAgentThread.mock.calls[0]).toEqual([
        { source: 'custom', id: 'my-agent' },
        'do the thing',
        'notes',
        'Notes',
        null,
        undefined,
      ]);
    });
  });

  describe('a swallowed launch intent', () => {
    test('reports a collision rather than eating the typed prompt', async () => {
      window.location.hash = '';
      mockLaunchOutcome = 'deduped';
      mockRegisteredAgent = { source: 'registry', id: 'claude-acp', name: 'Claude Agent' };
      render(
        <Harness
          threadLaunch={{
            agentSource: 'registry',
            agentId: 'claude-acp',
            prompt: 'the words I just typed',
            docName: null,
            titleHint: null,
            attachments: null,
            nonce: 1,
          }}
        />,
      );

      await vi.waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    });

    test('a launch that starts says nothing', async () => {
      window.location.hash = '';
      mockLaunchOutcome = 'started';
      mockRegisteredAgent = { source: 'registry', id: 'claude-acp', name: 'Claude Agent' };
      render(
        <Harness
          threadLaunch={{
            agentSource: 'registry',
            agentId: 'claude-acp',
            prompt: 'the words I just typed',
            docName: null,
            titleHint: null,
            attachments: null,
            nonce: 1,
          }}
        />,
      );

      await vi.waitFor(() => expect(launchAgentThread).toHaveBeenCalledTimes(1));
      expect(toastError).not.toHaveBeenCalled();
    });
  });

  describe('seed on reveal', () => {
    test('revealing an empty panel starts one conversation when an agent resolves', () => {
      window.location.hash = '';
      mockRegisteredAgent = { source: 'registry', id: 'claude-acp', name: 'Claude Agent' };
      const control = makeControl();
      render(<Harness initialVisible={false} control={control} />);
      expect(launchAgentThread).not.toHaveBeenCalled();

      act(() => control.current?.setVisible(true));

      expect(launchAgentThread).toHaveBeenCalledTimes(1);
      expect(launchAgentThread.mock.calls[0]).toEqual([
        { source: 'registry', id: 'claude-acp' },
        null,
        null,
        null,
        null,
        undefined,
      ]);
      expect(registerAgent).not.toHaveBeenCalled();
    });

    test('a reveal before the registry lands still gets its conversation once it does', () => {
      window.location.hash = '';
      mockRegisteredAgent = null;
      const control = makeControl();
      render(<Harness initialVisible={false} control={control} />);

      act(() => control.current?.setVisible(true));
      expect(launchAgentThread).not.toHaveBeenCalled();
      expect(window.location.hash).toBe('');

      mockRegisteredAgent = { source: 'registry', id: 'claude-acp', name: 'Claude Agent' };
      act(() => control.current?.rerender());

      expect(launchAgentThread).toHaveBeenCalledTimes(1);
      expect(launchAgentThread.mock.calls[0][0]).toEqual({ source: 'registry', id: 'claude-acp' });
    });

    test('re-subscribing the agents order restore keeps a reveal seed another effect owes', async () => {
      window.location.hash = '';
      mockRegisteredAgent = null;
      const control = makeControl();
      const makeDockBridge = () =>
        ({
          terminal: {
            getDockState: async () => ({ terminalVisible: false, agentPanelVisible: false }),
            setDockState: vi.fn(() => ({ ok: true as const })),
          },
          editor: { notifyViewMenuStateChanged: vi.fn() },
        }) as unknown as OkDesktopBridge;

      render(<Harness bridge={makeDockBridge()} initialVisible={false} control={control} />);
      await act(async () => {});

      act(() => control.current?.setVisible(true));
      expect(launchAgentThread).not.toHaveBeenCalled();

      await act(async () => {
        control.current?.setBridge(makeDockBridge());
      });

      mockRegisteredAgent = { source: 'registry', id: 'claude-acp', name: 'Claude Agent' };
      act(() => control.current?.rerender());

      expect(launchAgentThread).toHaveBeenCalledTimes(1);
      expect(launchAgentThread.mock.calls[0][0]).toEqual({ source: 'registry', id: 'claude-acp' });
    });

    test('a reveal owed a conversation drops the debt if the panel closes first', () => {
      mockRegisteredAgent = null;
      const control = makeControl();
      render(<Harness initialVisible={false} control={control} />);
      act(() => control.current?.setVisible(true));
      expect(launchAgentThread).not.toHaveBeenCalled();

      act(() => control.current?.setVisible(false));
      mockRegisteredAgent = { source: 'registry', id: 'claude-acp', name: 'Claude Agent' };
      act(() => control.current?.rerender());

      expect(launchAgentThread).not.toHaveBeenCalled();
    });

    test('an already-visible empty panel waits for the initial roster, then starts a conversation', () => {
      window.location.hash = '';
      mockRegisteredAgent = { source: 'registry', id: 'claude-acp', name: 'Claude Agent' };
      render(<Harness initialVisible />);

      expect(launchAgentThread).not.toHaveBeenCalled();

      act(() => setInitialRosterIds(new Set()));

      expect(launchAgentThread).toHaveBeenCalledTimes(1);
      expect(launchAgentThread.mock.calls[0][0]).toEqual({ source: 'registry', id: 'claude-acp' });
      expect(screen.getByText('Starting the agent…')).toBeDefined();
      expect(window.location.hash).toBe('');
    });

    test('an empty panel shows loading while agent discovery settles', () => {
      setInitialRosterIds(new Set());
      catalogLoading = true;

      render(<Harness initialVisible />);

      expect(screen.getByTestId('sessions-dock-loading').textContent).toContain('Loading agents…');
      expect(screen.queryByText('No agents enabled')).toBeNull();
    });

    test('archived history does not block an already-visible empty panel from starting a conversation', () => {
      mockRegisteredAgent = { source: 'registry', id: 'claude-acp', name: 'Claude Agent' };
      setArchivedThreads([makeThread({ threadId: 'archived', archived: true })]);
      setInitialRosterIds(new Set(['archived']));

      render(<Harness initialVisible />);

      expect(launchAgentThread).toHaveBeenCalledTimes(1);
      expect(launchAgentThread.mock.calls[0][0]).toEqual({ source: 'registry', id: 'claude-acp' });
    });

    test('an already-visible panel with a restored open conversation does not create another', async () => {
      mockRegisteredAgent = { source: 'registry', id: 'claude-acp', name: 'Claude Agent' };
      setOpenThreads([makeThread({ threadId: 'existing', title: 'Existing' })]);
      setInitialRosterIds(new Set(['existing']));

      render(<Harness initialVisible />);
      await screen.findByTestId('thread-view');

      expect(launchAgentThread).not.toHaveBeenCalled();
    });

    test('an already-visible panel does not replace a restored conversation that later closes', async () => {
      mockRegisteredAgent = { source: 'registry', id: 'claude-acp', name: 'Claude Agent' };
      setOpenThreads([makeThread({ threadId: 'existing', title: 'Existing' })]);
      setInitialRosterIds(new Set(['existing']));

      render(<Harness initialVisible />);
      await screen.findByTestId('thread-view');
      act(() => setOpenThreads([]));

      expect(launchAgentThread).not.toHaveBeenCalled();
      expect(screen.queryByTestId('sessions-dock-loading')).toBeNull();
      expect(screen.getByTestId('sessions-dock-empty').textContent).toBe('');
    });

    test('a failed agent catalog read offers a retry instead of reading as "No agents enabled."', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        mockRegisteredAgent = null;
        catalogError = new Error('agent catalog request failed: HTTP 503');
        setInitialRosterIds(new Set());

        render(<Harness initialVisible />);

        expect(screen.queryByTestId('sessions-dock-no-agents')).toBeNull();
        expect(screen.queryByText('No agents enabled.')).toBeNull();
        expect(screen.getByTestId('sessions-dock-agents-unavailable').textContent).toContain(
          "Couldn't load your agents.",
        );
        expect(consoleError).toHaveBeenCalled();

        await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

        expect(refetchCatalog).toHaveBeenCalledTimes(1);
        expect(launchAgentThread).not.toHaveBeenCalled();
      } finally {
        consoleError.mockRestore();
      }
    });

    test('an empty panel with no enabled agent links to Configure agents', async () => {
      window.location.hash = '';
      mockRegisteredAgent = null;
      setInitialRosterIds(new Set());
      render(<Harness initialVisible />);

      expect(screen.getByText('No agents enabled.')).toBeDefined();
      await userEvent.click(screen.getByRole('button', { name: 'Configure agents' }));

      expect(launchAgentThread).not.toHaveBeenCalled();
      expect(window.location.hash).toBe('#settings/agent-connections');
    });

    test('a failed automatic launch offers a retry', async () => {
      mockRegisteredAgent = { source: 'registry', id: 'claude-acp', name: 'Claude Agent' };
      mockLaunchOutcome = 'failed';
      setInitialRosterIds(new Set());

      render(<Harness initialVisible />);

      expect(await screen.findByText("Couldn't start the agent thread.")).toBeDefined();
      mockLaunchOutcome = 'deduped';
      await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

      expect(toastError).toHaveBeenCalledTimes(1);
      expect(screen.queryByText("Couldn't start the agent thread.")).toBeNull();
      expect(screen.queryByText('Starting the agent…')).toBeNull();
      expect(
        screen.getByText('Already starting a chat with this agent — try again in a moment.'),
      ).toBeDefined();
      const retry = screen.getByRole('button', { name: 'Try again' });
      await waitFor(() => expect(document.activeElement).toBe(retry));
    });

    test('a retry that fails again focuses the replacement retry action', async () => {
      mockRegisteredAgent = { source: 'registry', id: 'claude-acp', name: 'Claude Agent' };
      mockLaunchOutcome = 'failed';
      setInitialRosterIds(new Set());

      render(<Harness initialVisible />);

      const retry = await screen.findByRole('button', { name: 'Try again' });
      await userEvent.click(retry);

      const replacement = await screen.findByRole('button', { name: 'Try again' });
      await waitFor(() => expect(document.activeElement).toBe(replacement));
    });

    test('revealing a panel that already has a conversation does not create another', async () => {
      mockRegisteredAgent = { source: 'registry', id: 'claude-acp', name: 'Claude Agent' };
      setOpenThreads([makeThread({ threadId: 't1', title: 'Existing' })]);
      const control = makeControl();
      render(<Harness initialVisible={false} control={control} />);
      await screen.findByTestId('thread-view');

      act(() => control.current?.setVisible(true));

      expect(launchAgentThread).not.toHaveBeenCalled();
    });

    test('revealing while a thread launch is pending does not seed a second conversation', () => {
      window.location.hash = '';
      mockRegisteredAgent = { source: 'registry', id: 'claude-acp', name: 'Claude Agent' };
      const control = makeControl();
      render(<Harness initialVisible={false} control={control} />);

      act(() => {
        control.current?.setThreadLaunch({
          agentSource: 'custom',
          agentId: 'handoff-agent',
          prompt: 'do it',
          docName: null,
          titleHint: null,
          attachments: null,
          nonce: 1,
        });
        control.current?.setVisible(true);
      });

      expect(launchAgentThread).toHaveBeenCalledTimes(1);
      expect(launchAgentThread.mock.calls[0][0]).toEqual({ source: 'custom', id: 'handoff-agent' });
    });

    test('re-revealing while a launched thread is still being created does not seed a duplicate', () => {
      window.location.hash = '';
      mockRegisteredAgent = { source: 'registry', id: 'claude-acp', name: 'Claude Agent' };
      const control = makeControl();
      render(<Harness initialVisible={false} control={control} />);

      act(() => {
        control.current?.setThreadLaunch({
          agentSource: 'custom',
          agentId: 'handoff-agent',
          prompt: 'do it',
          docName: null,
          titleHint: null,
          attachments: null,
          nonce: 1,
        });
        control.current?.setVisible(true);
      });
      expect(launchAgentThread).toHaveBeenCalledTimes(1);

      act(() => control.current?.setVisible(false));
      act(() => control.current?.setVisible(true));

      expect(launchAgentThread).toHaveBeenCalledTimes(1);
      expect(launchAgentThread.mock.calls[0][0]).toEqual({ source: 'custom', id: 'handoff-agent' });
    });

    test('a launch that fails to land re-enables reveal-seed once it is no longer in flight', () => {
      window.location.hash = '';
      mockRegisteredAgent = { source: 'registry', id: 'claude-acp', name: 'Claude Agent' };
      const control = makeControl();
      render(<Harness initialVisible={false} control={control} />);

      act(() => {
        control.current?.setThreadLaunch({
          agentSource: 'custom',
          agentId: 'handoff-agent',
          prompt: null,
          docName: null,
          titleHint: null,
          attachments: null,
          nonce: 1,
        });
        control.current?.setVisible(true);
      });
      expect(launchAgentThread).toHaveBeenCalledTimes(1);

      mockInflightLaunch = false;
      act(() => control.current?.setVisible(false));
      act(() => control.current?.setVisible(true));

      expect(launchAgentThread).toHaveBeenCalledTimes(2);
      expect(launchAgentThread.mock.calls[1][0]).toEqual({ source: 'registry', id: 'claude-acp' });
    });

    test('a conversation created on one reveal is not duplicated on the next reveal', async () => {
      window.location.hash = '';
      mockRegisteredAgent = { source: 'registry', id: 'claude-acp', name: 'Claude Agent' };
      const control = makeControl();
      render(<Harness initialVisible={false} control={control} />);

      act(() => control.current?.setVisible(true));
      expect(launchAgentThread).toHaveBeenCalledTimes(1);

      setOpenThreads([makeThread({ threadId: 't1', title: 'Seeded' })]);
      await screen.findByTestId('thread-view');

      act(() => control.current?.setVisible(false));
      act(() => control.current?.setVisible(true));
      expect(launchAgentThread).toHaveBeenCalledTimes(1);
    });
  });

  test('a dropped WS shows the reconnecting banner above the active thread', async () => {
    render(<Harness />);
    setOpenThreads([makeThread({ threadId: 't1', title: 'Work' })]);
    await screen.findByTestId('thread-view');

    expect(screen.queryByTestId('agent-thread-reconnecting')).toBeNull();

    setConnectionStatus('closed');
    expect(await screen.findByTestId('agent-thread-reconnecting')).toBeDefined();

    setConnectionStatus('open');
    await waitFor(() => expect(screen.queryByTestId('agent-thread-reconnecting')).toBeNull());
  });
});
