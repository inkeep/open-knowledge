import type { ThreadInfo } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import * as actualLinguiMacro from '@lingui/react/macro';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { reloadEnabledAgentsFromStorage } from '@/lib/acp/enabled-agents';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import {
  readWebDockSessionOrder,
  writeAgentsPanelLevel,
  writeDockSessionOrder,
} from '@/lib/dock-session-persistence';
import { emitLocalMenuAction } from '@/lib/local-menu-action-bus';
import {
  __resetPaneVisibilityStoreForTests,
  paneVisibilityStore,
} from '@/lib/pane-visibility-store';
import { withUsableEditorHeader } from './editor-pane-focus.test-helper';

let openThreads: ThreadInfo[] = [];
let connectionStatus: 'idle' | 'connecting' | 'open' | 'closed' = 'open';
let rosterThreadIds: ReadonlySet<string> | null = null;
const storeListeners = new Set<() => void>();
let attachSessionHosts = false;

function notifyStore() {
  for (const listener of storeListeners) listener();
}

function setOpenThreads(next: ThreadInfo[]) {
  openThreads = next;
  notifyStore();
}

function deliverRosterThreads(next: ThreadInfo[]) {
  if (rosterThreadIds === null) {
    rosterThreadIds = new Set(next.map((info) => info.threadId));
  }
  setOpenThreads(next);
}

function pushLiveThreads(next: ThreadInfo[]) {
  setOpenThreads(next);
}

function subscribeStore(callback: () => void) {
  storeListeners.add(callback);
  return () => storeListeners.delete(callback);
}

vi.doMock('@/lib/acp/thread-client', () => ({
  useAgentThreads: () =>
    useSyncExternalStore(
      subscribeStore,
      () => openThreads,
      () => openThreads,
    ),
  useOpenAgentThreadTabs: () =>
    useSyncExternalStore(
      subscribeStore,
      () => openThreads,
      () => openThreads,
    ),
  useInitialRosterThreadIds: () => rosterThreadIds,
  useAgentThreadConnection: () =>
    useSyncExternalStore(
      subscribeStore,
      () => connectionStatus,
      () => connectionStatus,
    ),
  useAgentThreadScope: () => null,
  useAgentThreadUnread: () => false,
  getAgentThreadClient: () => ({
    closeThread: vi.fn(),
    renameThread: vi.fn(),
    openArchivedThread: vi.fn(),
    deleteThread: vi.fn(),
    markThreadViewed: () => {},
  }),
  ThreadChannelUnavailableError: class ThreadChannelUnavailableError extends Error {},
}));

vi.doMock('@/components/acp/ThreadView', () => ({
  ThreadView: ({ info }: { info: ThreadInfo }) => (
    <div data-testid="thread-view" data-thread-id={info.threadId} />
  ),
}));

const registerAgent = vi.fn((_agent: unknown) => {});

const { pickEffectiveDefaultAgent } = await vi.importActual<
  typeof import('@/lib/acp/registered-agents')
>('@/lib/acp/registered-agents');

vi.doMock('@/lib/acp/registered-agents', () => ({
  useRegisteredAgents: () => [],
  useDefaultRegisteredAgent: () => null,
  getDefaultRegisteredAgent: () => null,
  registerAgent,
  pickEffectiveDefaultAgent,
  hydrateRegisteredAgentMeta: () => {},
}));

vi.doMock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

vi.doMock('@/lib/acp/launch-agent-thread', () => ({
  launchAgentThread: vi.fn(() => Promise.resolve('started' as const)),
  hasInflightThreadLaunch: () => false,
}));

vi.doMock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined, isLoading: false, isError: false }),
}));

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) => (
    <>{(value === 1 ? one : other).replace('#', String(value))}</>
  ),
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

vi.doMock('@/hooks/use-git-sync-status', () => ({
  useGitSyncStatus: () => ({ hasRemote: false, pushPermission: { checkStatus: 'allowed' } }),
}));

vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    projectConfig: null,
    projectLocalConfig: null,
    projectLocalSynced: false,
    projectSynced: false,
  }),
}));

vi.doMock('@/lib/use-workspace', () => ({
  useWorkspace: () => ({ contentDir: '/tmp/project', pathSeparator: '/' }),
}));

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    activeDocName: 'docs/notes',
    collabUrl: 'ws://test',
    activeProvider: undefined,
  }),
  isBlobRunnerNewTabId: () => false,
}));

vi.doMock('@/editor/preview-tab-promotion', () => ({
  requestPreviewTabPromotion: () => {},
}));

vi.doMock('@/editor/use-editor-mode', () => ({
  useEditorMode: () => ['wysiwyg', () => {}],
}));

vi.doMock('./EditorHeader', () => ({
  EditorHeader: ({ children }: { children?: ReactNode }) => (
    <div data-testid="editor-header">{children}</div>
  ),
}));

vi.doMock('./EditorArea', () => ({
  EditorArea: ({
    agentsVisible,
    onAgentsVisibleChange,
    onSessionPlacements,
  }: {
    agentsVisible?: boolean;
    onAgentsVisibleChange?: (visible: boolean) => void;
    onSessionPlacements?: (placements: unknown) => void;
  }) => {
    const [agentsContainer] = useState(() => document.createElement('div'));
    const [terminalContainer] = useState(() => document.createElement('div'));
    useEffect(() => {
      onSessionPlacements?.({
        terminal: { container: terminalContainer, isShowing: false },
        agents: { container: agentsContainer, isShowing: agentsVisible === true },
        editorRegion: document.createElement('div'),
      });
    }, [agentsContainer, terminalContainer, agentsVisible, onSessionPlacements]);
    useEffect(() => {
      if (!attachSessionHosts) return;
      document.body.append(agentsContainer, terminalContainer);
      return () => {
        agentsContainer.remove();
        terminalContainer.remove();
      };
    }, [agentsContainer, terminalContainer]);
    if (agentsVisible)
      return (
        <div data-testid="agents-column">
          <button
            type="button"
            data-testid="agents-collapse"
            onClick={() => onAgentsVisibleChange?.(false)}
          />
        </div>
      );
    return null;
  },
}));

vi.doMock('./acp/AgentThreadClientBinder', () => ({
  AgentThreadClientBinder: () => null,
}));

vi.doMock('@/lib/terminal-telemetry', () => ({
  recordTerminalOpened: () => {},
  recordShellConsentGranted: () => undefined,
}));

vi.doMock('./AuthModal', () => ({
  AuthModal: () => <div data-testid="auth-modal" />,
}));

vi.doMock('@/editor/components/TagDialog', () => ({
  TagDialog: () => <div data-testid="tag-dialog" />,
}));

vi.doMock('./AutoSyncOnboardingDialog', () => ({
  AutoSyncOnboardingDialog: () => <div data-testid="auto-sync-onboarding" />,
}));

const { EditorPane } = await import('./EditorPane');

type DockStatePayload = {
  terminalVisible: boolean;
  agentPanelVisible: boolean;
};

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

function seedPersistedAgentsPanelLevel(agentPanelVisible: boolean): void {
  writeDockSessionOrder(null, 'agents', { order: ['t1'], activeKey: 't1' });
  writeAgentsPanelLevel(null, agentPanelVisible);
}

function seedLegacyRecordWithoutPanelLevel(): void {
  writeDockSessionOrder(null, 'agents', { order: ['t1'], activeKey: 't1' });
}

function readPersistedAgentsPanelLevel(): boolean | undefined {
  return readWebDockSessionOrder('agents')?.agentPanelVisible;
}

function deferredDockState(): {
  promise: Promise<DockStatePayload>;
  resolve: (state: DockStatePayload) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (state: DockStatePayload) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<DockStatePayload>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function installDesktopBridge(
  getDockState: () => Promise<DockStatePayload>,
  hooks: { onViewMenuStateChanged?: (state: Record<string, unknown>) => void } = {},
): void {
  (window as { okDesktop?: unknown }).okDesktop = {
    config: { ptyAvailable: true },
    platform: 'darwin',
    onMenuAction: () => () => {},
    editor: {
      notifyViewMenuStateChanged: (state: Record<string, unknown>) =>
        hooks.onViewMenuStateChanged?.(state),
    },
    terminal: {
      getDockState,
      setDockState: () => ({ ok: true as const }),
      cliInstalledMap: async () => ({
        claude: true,
        codex: false,
        opencode: false,
        cursor: false,
      }),
    },
  } as unknown as OkDesktopBridge;
}

async function renderPane(expectedStoreSubscribers: number): Promise<void> {
  render(
    <TooltipProvider>
      <EditorPane />
    </TooltipProvider>,
  );
  await act(async () => {});
  await vi.dynamicImportSettled();
  await act(async () => {});
  await waitFor(
    () => expect(storeListeners.size).toBeGreaterThanOrEqual(expectedStoreSubscribers),
    { timeout: 5_000 },
  );
}

describe('EditorPane agents-panel reload visibility', () => {
  beforeEach(() => {
    openThreads = [];
    connectionStatus = 'open';
    rosterThreadIds = null;
    localStorage.clear();
    reloadEnabledAgentsFromStorage();
  });

  afterEach(() => {
    cleanup();
    attachSessionHosts = false;
    delete (window as { okDesktop?: unknown }).okDesktop;
    __resetPaneVisibilityStoreForTests();
  });

  test('web: a fresh mount restores a persisted open agents panel', async () => {
    seedPersistedAgentsPanelLevel(true);

    await renderPane(3);

    expect(screen.queryByTestId('agents-column')).not.toBeNull();
    expect(paneVisibilityStore.getSnapshot().agents?.open).toBe(true);
  });

  test('web: the reload roster snapshot does not reveal a panel persisted closed', async () => {
    seedPersistedAgentsPanelLevel(false);

    await renderPane(3);

    expect(screen.queryByTestId('agents-column')).toBeNull();
    expect(paneVisibilityStore.getSnapshot().agents?.open).toBe(false);

    await act(async () => {
      deliverRosterThreads([makeThread({ threadId: 't1' })]);
    });

    expect(screen.queryByTestId('agents-column')).toBeNull();
  });

  test('web: a thread going live after the reload roster snapshot reveals the persisted-closed panel', async () => {
    seedPersistedAgentsPanelLevel(false);

    await renderPane(3);

    await act(async () => {
      deliverRosterThreads([makeThread({ threadId: 't1' })]);
    });
    await act(async () => {
      pushLiveThreads([
        makeThread({ threadId: 't1' }),
        makeThread({ threadId: 't2', createdAt: 2, lastActivityAt: 2 }),
      ]);
    });

    expect(screen.queryByTestId('agents-column')).not.toBeNull();
  });

  test('web: a thread arriving after an empty reload roster reveals the persisted-closed panel', async () => {
    seedPersistedAgentsPanelLevel(false);

    await renderPane(3);

    await act(async () => {
      deliverRosterThreads([]);
    });
    await act(async () => {
      pushLiveThreads([makeThread({ threadId: 't1' })]);
    });

    expect(screen.queryByTestId('agents-column')).not.toBeNull();
  });

  test('web: a thread arriving after a persisted-open reload is collapsed reveals the panel', async () => {
    seedPersistedAgentsPanelLevel(true);

    await renderPane(3);

    expect(screen.queryByTestId('agents-column')).not.toBeNull();

    await act(async () => {
      deliverRosterThreads([makeThread({ threadId: 't1' })]);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('agents-collapse'));
    });

    expect(paneVisibilityStore.getSnapshot().agents?.open).toBe(false);

    await act(async () => {
      pushLiveThreads([
        makeThread({ threadId: 't1' }),
        makeThread({ threadId: 't2', createdAt: 2, lastActivityAt: 2 }),
      ]);
    });

    expect(screen.queryByTestId('agents-column')).not.toBeNull();
  });

  test('web: a legacy record without the panel level starts closed and the roster does not reveal it', async () => {
    seedLegacyRecordWithoutPanelLevel();

    await renderPane(3);

    expect(screen.queryByTestId('agents-column')).toBeNull();
    expect(paneVisibilityStore.getSnapshot().agents?.open).toBe(false);

    await act(async () => {
      deliverRosterThreads([makeThread({ threadId: 't1' })]);
    });

    expect(screen.queryByTestId('agents-column')).toBeNull();
  });

  test('desktop: a roster snapshot landing while the dock restore is pending does not reveal the closed panel', async () => {
    const pendingDockState = deferredDockState();
    installDesktopBridge(() => pendingDockState.promise);

    await renderPane(6);

    expect(screen.queryByTestId('agents-column')).toBeNull();
    expect(paneVisibilityStore.getSnapshot().agents?.open).toBe(false);

    await act(async () => {
      deliverRosterThreads([makeThread({ threadId: 't1' })]);
    });

    expect(screen.queryByTestId('agents-column')).toBeNull();

    await act(async () => {
      pendingDockState.resolve({ terminalVisible: false, agentPanelVisible: false });
    });

    expect(screen.queryByTestId('agents-column')).toBeNull();
  });

  test('desktop: a live thread arriving while the dock restore is pending reveals the panel once the restore settles', async () => {
    const pendingDockState = deferredDockState();
    installDesktopBridge(() => pendingDockState.promise);

    await renderPane(6);

    await act(async () => {
      deliverRosterThreads([makeThread({ threadId: 't1' })]);
    });
    await act(async () => {
      pushLiveThreads([
        makeThread({ threadId: 't1' }),
        makeThread({ threadId: 't2', createdAt: 2, lastActivityAt: 2 }),
      ]);
    });

    expect(screen.queryByTestId('agents-column')).toBeNull();

    await act(async () => {
      pendingDockState.resolve({ terminalVisible: false, agentPanelVisible: false });
    });

    expect(screen.queryByTestId('agents-column')).not.toBeNull();
  });

  test('web: the persist write keeps the agents-panel level closed through the reload roster snapshot', async () => {
    seedPersistedAgentsPanelLevel(false);

    await renderPane(3);

    expect(readPersistedAgentsPanelLevel()).toBe(false);

    await act(async () => {
      deliverRosterThreads([makeThread({ threadId: 't1' })]);
    });

    expect(screen.queryByTestId('agents-column')).toBeNull();
    expect(readPersistedAgentsPanelLevel()).toBe(false);
  });

  test('web: a header show and hide persist the agents-panel level', async () => {
    await renderPane(3);

    expect(readPersistedAgentsPanelLevel()).toBe(false);

    await act(async () => {
      paneVisibilityStore.request('agents', true);
    });

    expect(screen.queryByTestId('agents-column')).not.toBeNull();
    expect(readPersistedAgentsPanelLevel()).toBe(true);

    await act(async () => {
      paneVisibilityStore.request('agents', false);
    });

    expect(screen.queryByTestId('agents-column')).toBeNull();
    expect(readPersistedAgentsPanelLevel()).toBe(false);
  });

  test('web: a user reveal request focuses the empty Agents action from the Editor header', async () => {
    attachSessionHosts = true;
    await renderPane(3);

    await withUsableEditorHeader(async () => {
      act(() => paneVisibilityStore.request('agents', true, 'user'));

      const action = await screen.findByRole('button', { name: 'Start an agent' });
      await waitFor(() => expect(document.activeElement).toBe(action));
    });
  });

  test('web: the Agents menu toggle focuses the empty Agents action from the Editor header', async () => {
    attachSessionHosts = true;
    await renderPane(3);

    await withUsableEditorHeader(async () => {
      act(() => emitLocalMenuAction('toggle-agent-panel'));

      const action = await screen.findByRole('button', { name: 'Start an agent' });
      await waitFor(() => expect(document.activeElement).toBe(action));
    });
  });

  test('desktop: a header show during a pending dock restore reads closed first and survives settlement', async () => {
    const pendingDockState = deferredDockState();
    const viewMenuStates: Array<Record<string, unknown>> = [];
    installDesktopBridge(() => pendingDockState.promise, {
      onViewMenuStateChanged: (state) => viewMenuStates.push(state),
    });

    await renderPane(6);

    expect(paneVisibilityStore.getSnapshot()).toEqual({
      editor: { open: true, onScreen: true },
      agents: { open: false, onScreen: false },
      terminal: { open: false, onScreen: false },
    });

    await act(async () => {
      paneVisibilityStore.request('agents', true);
      paneVisibilityStore.request('terminal', true);
    });

    expect(screen.queryByTestId('agents-column')).not.toBeNull();

    await act(async () => {
      pendingDockState.resolve({ terminalVisible: false, agentPanelVisible: false });
    });

    expect(screen.queryByTestId('agents-column')).not.toBeNull();
    expect(paneVisibilityStore.getSnapshot().agents?.open).toBe(true);
    expect(paneVisibilityStore.getSnapshot().terminal?.open).toBe(true);
    const levels = (key: string) =>
      viewMenuStates.filter((state) => key in state).map((state) => state[key]);
    expect(levels('agentPanelVisible').at(-1)).toBe(true);
    expect(levels('terminalVisible').at(-1)).toBe(true);
  });

  test('desktop: a toggle during a pending dock restore survives settlement with the toggled level', async () => {
    const pendingDockState = deferredDockState();
    const viewMenuStates: Array<Record<string, unknown>> = [];
    installDesktopBridge(() => pendingDockState.promise, {
      onViewMenuStateChanged: (state) => viewMenuStates.push(state),
    });

    await renderPane(6);

    await act(async () => {
      paneVisibilityStore.request('agents', true);
    });

    expect(screen.queryByTestId('agents-column')).not.toBeNull();

    await act(async () => {
      pendingDockState.resolve({ terminalVisible: false, agentPanelVisible: false });
    });

    expect(screen.queryByTestId('agents-column')).not.toBeNull();

    const levelPublish = [...viewMenuStates]
      .reverse()
      .find((state) => 'agentPanelVisible' in state);
    expect(levelPublish?.agentPanelVisible).toBe(true);
  });

  test('desktop: a live thread after the dock restore settles reveals the persisted-closed panel', async () => {
    const pendingDockState = deferredDockState();
    installDesktopBridge(() => pendingDockState.promise);

    await renderPane(6);

    await act(async () => {
      deliverRosterThreads([makeThread({ threadId: 't1' })]);
    });
    await act(async () => {
      pendingDockState.resolve({ terminalVisible: false, agentPanelVisible: false });
    });
    await act(async () => {
      pushLiveThreads([
        makeThread({ threadId: 't1' }),
        makeThread({ threadId: 't2', createdAt: 2, lastActivityAt: 2 }),
      ]);
    });

    expect(screen.queryByTestId('agents-column')).not.toBeNull();
  });

  test('web: an arrival after the roster collapses to zero reveals the persisted-closed panel', async () => {
    deliverRosterThreads([makeThread({ threadId: 't1' })]);
    seedPersistedAgentsPanelLevel(false);

    await renderPane(3);

    expect(screen.queryByTestId('agents-column')).toBeNull();

    await act(async () => {
      pushLiveThreads([]);
    });

    expect(screen.queryByTestId('agents-column')).toBeNull();

    await act(async () => {
      pushLiveThreads([makeThread({ threadId: 't2', createdAt: 2, lastActivityAt: 2 })]);
    });

    expect(screen.queryByTestId('agents-column')).not.toBeNull();
  });

  test('desktop: a hung dock-state restore force-settles at the deadline, warns, writes nothing, and a thread arriving afterwards still reveals the panel', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hungDockState = deferredDockState();
    const viewMenuStates: Array<Record<string, unknown>> = [];
    installDesktopBridge(() => hungDockState.promise, {
      onViewMenuStateChanged: (state) => viewMenuStates.push(state),
    });

    try {
      await Promise.all([import('./SessionsHost'), import('./acp/AgentThreadClientBinder')]);
      render(
        <TooltipProvider>
          <EditorPane />
        </TooltipProvider>,
      );
      await act(async () => {});
      expect(storeListeners.size).toBeGreaterThanOrEqual(6);

      expect(screen.queryByTestId('agents-column')).toBeNull();
      expect(viewMenuStates).not.toContainEqual({
        terminalVisible: false,
        wideIntent: { terminalVisible: false },
      });

      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });

      expect(
        warnSpy.mock.calls.some((call) =>
          String(call[0]).includes(
            'dock-state restore exceeded its 5000ms bound; the agents panel and terminal start closed and the editor starts shown until the read lands; a read that still lands reveals nothing, and hides the editor only when the saved layout had no pane open and the user has not chosen an editor level since mount; each level still unrestored is withheld from the view menu and the dock record, so a later reveal or toggle still publishes',
          ),
        ),
      ).toBe(true);
      expect(viewMenuStates).not.toContainEqual({
        terminalVisible: false,
        wideIntent: { terminalVisible: false },
      });
      expect(viewMenuStates).not.toContainEqual({
        agentPanelVisible: false,
        wideIntent: { agentPanelVisible: false },
      });
      expect(viewMenuStates).not.toContainEqual({
        editorVisible: true,
        wideIntent: { editorVisible: true },
      });

      await act(async () => {
        pushLiveThreads([
          makeThread({ threadId: 't1' }),
          makeThread({ threadId: 't2', createdAt: 2, lastActivityAt: 2 }),
        ]);
      });

      expect(screen.queryByTestId('agents-column')).not.toBeNull();
      expect(viewMenuStates).toContainEqual({
        agentPanelVisible: true,
        wideIntent: { agentPanelVisible: true },
      });
      expect(viewMenuStates).not.toContainEqual({
        terminalVisible: false,
        wideIntent: { terminalVisible: false },
      });

      await act(async () => {
        hungDockState.resolve({ terminalVisible: true, agentPanelVisible: false });
      });

      expect(viewMenuStates).not.toContainEqual({
        terminalVisible: true,
        wideIntent: { terminalVisible: true },
      });
      expect(screen.queryByTestId('agents-column')).not.toBeNull();
    } finally {
      vi.useRealTimers();
      warnSpy.mockRestore();
    }
  });

  test('desktop: a failed dock-state restore settles without writing the un-restored defaults', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failingDockState = deferredDockState();
    const viewMenuStates: Array<Record<string, unknown>> = [];
    installDesktopBridge(() => failingDockState.promise, {
      onViewMenuStateChanged: (state) => viewMenuStates.push(state),
    });

    try {
      await Promise.all([import('./SessionsHost'), import('./acp/AgentThreadClientBinder')]);
      render(
        <TooltipProvider>
          <EditorPane />
        </TooltipProvider>,
      );
      await act(async () => {});

      await act(async () => {
        failingDockState.reject(new Error('dock-state ipc failed'));
      });

      expect(
        errorSpy.mock.calls.some((call) =>
          String(call[0]).includes(
            'dock-state restore failed; the agents panel and terminal start closed and the editor starts shown without its saved state applied;',
          ),
        ),
      ).toBe(true);
      expect(viewMenuStates).toContainEqual({ terminalPlacement: 'bottom' });
      expect(viewMenuStates).not.toContainEqual({
        terminalVisible: false,
        wideIntent: { terminalVisible: false },
      });
      expect(viewMenuStates).not.toContainEqual({
        agentPanelVisible: false,
        wideIntent: { agentPanelVisible: false },
      });
      expect(viewMenuStates).not.toContainEqual({
        editorVisible: true,
        wideIntent: { editorVisible: true },
      });

      await act(async () => {
        paneVisibilityStore.request('agents', true);
      });

      expect(viewMenuStates).toContainEqual({
        agentPanelVisible: true,
        wideIntent: { agentPanelVisible: true },
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('desktop: a panel opened and closed before an ABANDONED settle publishes the closed level, and the untouched terminal level stays withheld', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hungDockState = deferredDockState();
    const viewMenuStates: Array<Record<string, unknown>> = [];
    installDesktopBridge(() => hungDockState.promise, {
      onViewMenuStateChanged: (state) => viewMenuStates.push(state),
    });

    try {
      await Promise.all([import('./SessionsHost'), import('./acp/AgentThreadClientBinder')]);
      render(
        <TooltipProvider>
          <EditorPane />
        </TooltipProvider>,
      );
      await act(async () => {});

      await act(async () => {
        paneVisibilityStore.request('agents', true);
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('agents-collapse'));
      });
      expect(viewMenuStates).not.toContainEqual({
        agentPanelVisible: true,
        wideIntent: { agentPanelVisible: true },
      });
      expect(viewMenuStates).not.toContainEqual({
        agentPanelVisible: false,
        wideIntent: { agentPanelVisible: false },
      });

      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });

      expect(viewMenuStates).toContainEqual({
        agentPanelVisible: false,
        wideIntent: { agentPanelVisible: false },
      });
      expect(viewMenuStates).not.toContainEqual({
        terminalVisible: false,
        wideIntent: { terminalVisible: false },
      });
    } finally {
      vi.useRealTimers();
      warnSpy.mockRestore();
    }
  });

  test('desktop: a panel opened and closed before a REJECTED read publishes the closed level too', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failingDockState = deferredDockState();
    const viewMenuStates: Array<Record<string, unknown>> = [];
    installDesktopBridge(() => failingDockState.promise, {
      onViewMenuStateChanged: (state) => viewMenuStates.push(state),
    });

    try {
      await Promise.all([import('./SessionsHost'), import('./acp/AgentThreadClientBinder')]);
      render(
        <TooltipProvider>
          <EditorPane />
        </TooltipProvider>,
      );
      await act(async () => {});

      await act(async () => {
        paneVisibilityStore.request('agents', true);
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('agents-collapse'));
      });
      expect(viewMenuStates).not.toContainEqual({
        agentPanelVisible: false,
        wideIntent: { agentPanelVisible: false },
      });

      await act(async () => {
        failingDockState.reject(new Error('dock-state ipc failed'));
      });

      expect(viewMenuStates).toContainEqual({
        agentPanelVisible: false,
        wideIntent: { agentPanelVisible: false },
      });
      expect(viewMenuStates).not.toContainEqual({
        terminalVisible: false,
        wideIntent: { terminalVisible: false },
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('desktop: a rejection landing after the force-settle deadline does not re-gate later levels', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hungDockState = deferredDockState();
    const viewMenuStates: Array<Record<string, unknown>> = [];
    installDesktopBridge(() => hungDockState.promise, {
      onViewMenuStateChanged: (state) => viewMenuStates.push(state),
    });

    try {
      await Promise.all([import('./SessionsHost'), import('./acp/AgentThreadClientBinder')]);
      render(
        <TooltipProvider>
          <EditorPane />
        </TooltipProvider>,
      );
      await act(async () => {});

      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });

      await act(async () => {
        paneVisibilityStore.request('agents', true);
      });

      expect(viewMenuStates).toContainEqual({
        agentPanelVisible: true,
        wideIntent: { agentPanelVisible: true },
      });

      const lateRejection = new Error('dock-state ipc failed after the deadline');
      await act(async () => {
        hungDockState.reject(lateRejection);
      });

      expect(
        errorSpy.mock.calls.some(
          (call) =>
            String(call[0]).includes('dock-state restore failed') && call[1] === lateRejection,
        ),
      ).toBe(true);

      await act(async () => {
        fireEvent.click(screen.getByTestId('agents-collapse'));
      });

      expect(viewMenuStates).toContainEqual({
        agentPanelVisible: false,
        wideIntent: { agentPanelVisible: false },
      });
    } finally {
      vi.useRealTimers();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test('desktop: a toggle during a pending dock restore survives the force-settle deadline with the toggled level', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hungDockState = deferredDockState();
    const viewMenuStates: Array<Record<string, unknown>> = [];
    installDesktopBridge(() => hungDockState.promise, {
      onViewMenuStateChanged: (state) => viewMenuStates.push(state),
    });

    try {
      await Promise.all([import('./SessionsHost'), import('./acp/AgentThreadClientBinder')]);
      render(
        <TooltipProvider>
          <EditorPane />
        </TooltipProvider>,
      );
      await act(async () => {});

      await act(async () => {
        paneVisibilityStore.request('agents', true);
      });

      expect(screen.queryByTestId('agents-column')).not.toBeNull();
      expect(viewMenuStates).not.toContainEqual({
        agentPanelVisible: true,
        wideIntent: { agentPanelVisible: true },
      });

      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });

      expect(screen.queryByTestId('agents-column')).not.toBeNull();
      expect(viewMenuStates).toContainEqual({
        agentPanelVisible: true,
        wideIntent: { agentPanelVisible: true },
      });
      expect(viewMenuStates).not.toContainEqual({
        agentPanelVisible: false,
        wideIntent: { agentPanelVisible: false },
      });
    } finally {
      vi.useRealTimers();
      warnSpy.mockRestore();
    }
  });

  test('desktop: a toggle during a pending dock restore survives a restore rejection with the toggled level', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failingDockState = deferredDockState();
    const viewMenuStates: Array<Record<string, unknown>> = [];
    installDesktopBridge(() => failingDockState.promise, {
      onViewMenuStateChanged: (state) => viewMenuStates.push(state),
    });

    try {
      await Promise.all([import('./SessionsHost'), import('./acp/AgentThreadClientBinder')]);
      render(
        <TooltipProvider>
          <EditorPane />
        </TooltipProvider>,
      );
      await act(async () => {});

      await act(async () => {
        paneVisibilityStore.request('agents', true);
      });

      expect(viewMenuStates).not.toContainEqual({
        agentPanelVisible: true,
        wideIntent: { agentPanelVisible: true },
      });

      await act(async () => {
        failingDockState.reject(new Error('dock-state ipc failed'));
      });

      expect(screen.queryByTestId('agents-column')).not.toBeNull();
      expect(viewMenuStates).toContainEqual({
        agentPanelVisible: true,
        wideIntent: { agentPanelVisible: true },
      });
      expect(viewMenuStates).not.toContainEqual({
        agentPanelVisible: false,
        wideIntent: { agentPanelVisible: false },
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('desktop: a terminal toggle during a pending dock restore survives the force-settle deadline with the toggled level', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hungDockState = deferredDockState();
    const viewMenuStates: Array<Record<string, unknown>> = [];
    installDesktopBridge(() => hungDockState.promise, {
      onViewMenuStateChanged: (state) => viewMenuStates.push(state),
    });

    try {
      await Promise.all([import('./SessionsHost'), import('./acp/AgentThreadClientBinder')]);
      render(
        <TooltipProvider>
          <EditorPane />
        </TooltipProvider>,
      );
      await act(async () => {});

      await act(async () => {
        emitLocalMenuAction('toggle-terminal');
      });

      expect(viewMenuStates).not.toContainEqual({
        terminalVisible: true,
        wideIntent: { terminalVisible: true },
      });

      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });

      expect(viewMenuStates).toContainEqual({
        terminalVisible: true,
        wideIntent: { terminalVisible: true },
      });
      expect(viewMenuStates).not.toContainEqual({
        terminalVisible: false,
        wideIntent: { terminalVisible: false },
      });
    } finally {
      vi.useRealTimers();
      warnSpy.mockRestore();
    }
  });

  test('desktop: an on-time dock restore clears the deadline so no late bound-exceeded warn fires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deferred = deferredDockState();
    installDesktopBridge(() => deferred.promise);

    try {
      await Promise.all([import('./SessionsHost'), import('./acp/AgentThreadClientBinder')]);
      render(
        <TooltipProvider>
          <EditorPane />
        </TooltipProvider>,
      );
      await act(async () => {});
      expect(storeListeners.size).toBeGreaterThanOrEqual(6);

      await act(async () => {
        deferred.resolve({ terminalVisible: false, agentPanelVisible: true });
      });

      expect(screen.queryByTestId('agents-column')).not.toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });

      expect(
        warnSpy.mock.calls.some((call) => String(call[0]).includes('exceeded its 5000ms bound')),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
      warnSpy.mockRestore();
    }
  });
});
