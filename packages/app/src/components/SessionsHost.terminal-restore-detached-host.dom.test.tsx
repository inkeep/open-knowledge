// @vitest-environment jsdom
import type { ThreadInfo } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import type { SessionPlacements } from './EditorArea';
import { tabTitles } from './sessions-host-tabs.test-helper';

const COLD_START_DOC_CTX = {
  activeDocName: null,
  activeProvider: null,
  activeTarget: { kind: 'doc', target: 'some-doc', docName: 'some-doc' },
  recycleDocument: () => {},
  closeActivityPanel: () => {},
  docPanelMode: 'timeline',
  docPanelAgentId: null,
  docPanelExpandSignal: 0,
};
const LIVE_DOC_CTX = {
  ...COLD_START_DOC_CTX,
  activeDocName: 'some-doc',
  activeProvider: { configuration: { name: 'some-doc' } } as never,
};
let docCtx: typeof COLD_START_DOC_CTX = COLD_START_DOC_CTX;

vi.doMock('@/lib/perf', () => ({
  mark: () => {},
  ProfilerBoundary: ({ children }: { children: ReactNode }) => children,
}));
vi.doMock('@/components/PropertyContext', () => ({
  PropertyProvider: ({ children }: { children: ReactNode }) => children,
  useProperties: () => ({ requestAddProperty: () => {} }),
}));
vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({ projectBinding: null }),
}));
vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => docCtx,
  useDocumentTransition: () => ({ openDocumentTransition: null }),
  isBlobRunnerNewTabId: () => false,
}));
vi.doMock('@/hooks/use-document-stats', () => ({ useDocumentStats: () => null }));
vi.doMock('@/hooks/use-selection-stats', () => ({ useSelectionStats: () => null }));
vi.doMock('@/hooks/use-conflicts', () => ({ useDocConflict: () => null }));
vi.doMock('@/hooks/use-doc-panel-layout', () => ({
  useDocPanelLayout: () => ({ layout: 'panel', autoCollapse: false }),
}));
vi.doMock('@/presence/use-sync-status', () => ({ useSyncStatus: () => 'synced' }));
vi.doMock('@/lib/use-settings-route', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSettingsRoute: () => ({ open: false, close: () => {} }),
}));
vi.doMock('@/components/settings/SettingsDialogShell', () => ({
  SettingsDialogShell: () => <div data-testid="settings-shell" />,
}));
vi.doMock('@/components/EditorSkeleton', () => ({
  EditorSkeleton: () => <div data-testid="editor-skeleton" />,
}));
vi.doMock('@/components/EmptyEditorState', () => ({
  EmptyEditorState: () => <div data-testid="empty-editor-state" />,
}));
vi.doMock('./TerminalDock', () => ({
  TerminalDock: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.doMock('./EditorWorkspace', () => ({
  EditorWorkspace: ({
    renderPane,
  }: {
    renderPane: (context: {
      pane: { id: string };
      isFocused: boolean;
      activityDocName: string | null;
      activityMount: ReactNode;
    }) => ReactNode;
  }) => (
    <>
      {renderPane({
        pane: { id: 'pane-test' },
        isFocused: true,
        activityDocName: docCtx.activeDocName,
        activityMount: <div data-testid="activity-mount" />,
      })}
    </>
  ),
}));
vi.doMock('react-resizable-panels', () => ({
  usePanelRef: () => ({
    current: {
      collapse: () => {},
      expand: () => {},
      getSize: () => ({ asPercentage: 25, inPixels: 340 }),
      isCollapsed: () => false,
    },
  }),
  useGroupRef: () => ({ current: { getLayout: () => ({}), setLayout: () => {} } }),
}));
vi.doMock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children, id }: { children: ReactNode; id?: string }) => (
    <div id={id}>{children}</div>
  ),
  ResizableHandle: () => <div />,
}));
vi.doMock('./EditorActivityPool', () => ({
  EditorActivityPool: () => <div data-testid="editor-pool" />,
}));
vi.doMock('@/editor/find-replace/FindReplaceController', () => ({
  FindReplaceController: () => null,
}));
vi.doMock('./EditorToolbar', () => ({ EditorToolbar: () => <div data-testid="editor-toolbar" /> }));
vi.doMock('./EditorFooter', () => ({ EditorFooter: () => <div data-testid="editor-footer" /> }));
vi.doMock('./BottomComposer', () => ({
  BottomComposer: () => <div data-testid="bottom-composer" />,
}));
vi.doMock('./editor-area-overlay', () => ({ shouldPaintOverlay: () => false }));
vi.doMock('@/components/DocPanel', () => ({ DocPanel: () => <div data-testid="doc-panel" /> }));
let openAgentTabs: ThreadInfo[] = [];

vi.doMock('@/lib/acp/thread-client', () => ({
  useAgentThreads: () => openAgentTabs,
  useOpenAgentThreadTabs: () => openAgentTabs,
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

const PUBLISHED_CONTAINER_SELECTOR = '[data-published-container],[data-terminal-panel-mount]';

type GateMount = { readonly adopt: string; readonly hostInPublishedContainer: boolean };
const gateMounts: GateMount[] = [];
const gateLifecycle = { mounts: [] as string[], unmounts: [] as string[] };
let gateInstances = 0;

vi.doMock('./TerminalGate', () => ({
  TerminalGate: ({ adoptPtyId }: { adoptPtyId?: string | null }) => {
    const nodeRef = useRef<HTMLDivElement | null>(null);
    const [instanceId] = useState(() => {
      gateInstances += 1;
      return `terminal-gate-${gateInstances}`;
    });
    useEffect(() => {
      gateMounts.push({
        adopt: adoptPtyId ?? 'spawn-fresh',
        hostInPublishedContainer: nodeRef.current?.closest(PUBLISHED_CONTAINER_SELECTOR) != null,
      });
    }, [adoptPtyId]);
    useEffect(() => {
      gateLifecycle.mounts.push(instanceId);
      return () => {
        gateLifecycle.unmounts.push(instanceId);
      };
    }, [instanceId]);
    return <div ref={nodeRef} data-testid="terminal-gate" />;
  },
}));

type ThreadViewMount = { readonly threadId: string; readonly hostInPublishedContainer: boolean };
const threadViewMounts: ThreadViewMount[] = [];

vi.doMock('@/components/acp/ThreadView', () => ({
  ThreadView: ({ info }: { info: ThreadInfo }) => {
    const nodeRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
      threadViewMounts.push({
        threadId: info.threadId,
        hostInPublishedContainer: nodeRef.current?.closest(PUBLISHED_CONTAINER_SELECTOR) != null,
      });
    }, [info.threadId]);
    return <div ref={nodeRef} data-testid="thread-view" data-thread-id={info.threadId} />;
  },
}));

const { EditorArea } = await import('./EditorArea');
const { SessionsHost } = await import('./SessionsHost');

function gatesMountedIntoADetachedHost(): string[] {
  return gateMounts.filter((mount) => !mount.hostInPublishedContainer).map((mount) => mount.adopt);
}

function threadViewsMountedIntoADetachedHost(): string[] {
  return threadViewMounts
    .filter((mount) => !mount.hostInPublishedContainer)
    .map((mount) => mount.threadId);
}

function terminalDockHostStateRecords(
  calls: readonly (readonly unknown[])[],
): Array<Record<string, unknown>> {
  return calls.flatMap(([line]) => {
    if (typeof line !== 'string') return [];
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return [];
    }
    return record.event === 'ok-terminal-sessions-host-state' && record.surface === 'terminal-dock'
      ? [record]
      : [];
  });
}

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

function makeRestartBridge(): OkDesktopBridge {
  return {
    platform: 'win32',
    config: { ptyAvailable: true, mode: 'editor' },
    terminal: {
      create: vi.fn(async () => ({ ptyId: 'pty-new' })),
      kill: vi.fn(),
      input: vi.fn(),
      list: vi.fn(async () => []),
      getDockState: vi.fn(async () => ({
        terminalVisible: true,
        agentPanelVisible: false,
        terminal: { order: [], activeKey: null },
        terminalSnapshot: {
          activeOrdinal: 2,
          tabs: [
            { ordinal: 2, customLabel: 'process second' },
            { ordinal: 1, customLabel: 'process first' },
          ],
        },
      })),
      setDockState: vi.fn(async () => ({ ok: true as const })),
      cliInstalledMap: vi.fn(async () => ({})),
    },
    editor: { notifyViewMenuStateChanged: vi.fn() },
  } as unknown as OkDesktopBridge;
}

function ProducerHarness({ attachContainerAfterMs }: { attachContainerAfterMs: number }) {
  const [bridge] = useState(makeRestartBridge);
  const [attached, setAttached] = useState(attachContainerAfterMs === 0);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (attached) return;
    const id = window.setTimeout(() => setAttached(true), attachContainerAfterMs);
    return () => window.clearTimeout(id);
  }, [attached, attachContainerAfterMs]);
  return (
    <TooltipProvider>
      {attached ? (
        <div ref={setContainer} data-published-container data-testid="terminal-mount" />
      ) : null}
      <SessionsHost
        surface="terminal-dock"
        terminalPlacement="right"
        bridge={bridge}
        terminalCapable
        visible
        onVisibleChange={() => {}}
        installedClis={{}}
        container={container}
        isShowing={container != null}
        onRequestEditorFocus={() => {}}
      />
    </TooltipProvider>
  );
}

function AgentsHarness({ attachContainerAfterMs }: { attachContainerAfterMs: number }) {
  const [bridge] = useState(makeRestartBridge);
  const [attached, setAttached] = useState(attachContainerAfterMs === 0);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (attached) return;
    const id = window.setTimeout(() => setAttached(true), attachContainerAfterMs);
    return () => window.clearTimeout(id);
  }, [attached, attachContainerAfterMs]);
  return (
    <TooltipProvider>
      {attached ? (
        <div ref={setContainer} data-published-container data-testid="agents-mount" />
      ) : null}
      <SessionsHost
        surface="agents-panel"
        bridge={bridge}
        terminalCapable
        visible
        agentsVisibilityRestoreSettled
        onVisibleChange={() => {}}
        installedClis={{}}
        container={container}
        isShowing={container != null}
        onRequestEditorFocus={() => {}}
      />
    </TooltipProvider>
  );
}

type ContainerSlot = 'first' | 'none' | 'second';

function ChurnHarness({ slot }: { slot: ContainerSlot }) {
  const [bridge] = useState(makeRestartBridge);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  return (
    <TooltipProvider>
      {slot === 'first' ? (
        <div ref={setContainer} data-published-container data-testid="terminal-mount" />
      ) : null}
      {slot === 'second' ? (
        <div ref={setContainer} data-published-container data-testid="terminal-mount-second" />
      ) : null}
      <SessionsHost
        surface="terminal-dock"
        terminalPlacement="right"
        bridge={bridge}
        terminalCapable
        visible
        onVisibleChange={() => {}}
        installedClis={{}}
        container={container}
        isShowing={container != null}
        onRequestEditorFocus={() => {}}
      />
    </TooltipProvider>
  );
}

const publishedTerminalContainers: (HTMLElement | null)[] = [];

function CompositionHarness({ bridge }: { bridge: OkDesktopBridge }) {
  const [placements, setPlacements] = useState<SessionPlacements>({
    terminal: { container: null, isShowing: false },
    agents: { container: null, isShowing: false },
    editorRegion: null,
  });
  useEffect(() => {
    publishedTerminalContainers.push(placements.terminal.container);
  }, [placements]);
  return (
    <TooltipProvider>
      <EditorArea
        editorMode="wysiwyg"
        onModeChange={() => {}}
        activeTab="timeline"
        onActiveTabChange={() => {}}
        terminalBridge={bridge}
        terminalVisible
        terminalPlacement="right"
        onTerminalVisibleChange={() => {}}
        onSessionPlacements={setPlacements}
      />
      <SessionsHost
        surface="terminal-dock"
        terminalPlacement="right"
        bridge={bridge}
        terminalCapable
        visible
        onVisibleChange={() => {}}
        installedClis={{}}
        container={placements.terminal.container}
        isShowing={placements.terminal.isShowing}
        onRequestEditorFocus={() => {}}
      />
    </TooltipProvider>
  );
}

async function settle(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('terminal dock restore vs portal-host attachment', () => {
  beforeEach(() => {
    gateMounts.length = 0;
    threadViewMounts.length = 0;
    openAgentTabs = [];
    gateLifecycle.mounts.length = 0;
    gateLifecycle.unmounts.length = 0;
    gateInstances = 0;
    publishedTerminalContainers.length = 0;
    docCtx = COLD_START_DOC_CTX;
    localStorage.clear();
    window.location.hash = '';
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.location.hash = '';
  });

  test('mounts no terminal gate while the dock portal host is outside the document', async () => {
    render(<ProducerHarness attachContainerAfterMs={2000} />);

    await settle(500);
    expect(screen.queryByTestId('terminal-mount')).toBeNull();
    expect(gatesMountedIntoADetachedHost()).toEqual([]);

    await settle(3000);
    expect(screen.getAllByTestId('terminal-gate')).toHaveLength(2);
    expect(gatesMountedIntoADetachedHost()).toEqual([]);
  });

  test('mounts no terminal gate during the cold-start window that nulls the real container', async () => {
    window.location.hash = '#/some-doc';
    const bridge = makeRestartBridge();
    const view = render(<CompositionHarness bridge={bridge} />);

    await settle(500);
    expect(screen.getByTestId('editor-skeleton')).toBeTruthy();
    expect(document.querySelector('[data-terminal-panel-mount]')).toBeNull();
    expect(publishedTerminalContainers).toContain(null);
    expect(gatesMountedIntoADetachedHost()).toEqual([]);

    await act(async () => {
      docCtx = LIVE_DOC_CTX;
    });
    view.rerender(<CompositionHarness bridge={bridge} />);
    await settle(500);
    expect(document.querySelector('[data-terminal-panel-mount]')).not.toBeNull();
    expect(publishedTerminalContainers).toContain(
      document.querySelector('[data-terminal-panel-mount]'),
    );
    expect(screen.getAllByTestId('terminal-gate')).toHaveLength(2);
    expect(gatesMountedIntoADetachedHost()).toEqual([]);
  });

  test('keeps every restored terminal gate mounted when the dock container is withdrawn and replaced', async () => {
    const view = render(<ChurnHarness slot="first" />);

    await settle(3000);
    expect(screen.getAllByTestId('terminal-gate')).toHaveLength(2);
    expect(tabTitles()).toEqual(['process second', 'process first']);
    expect(gatesMountedIntoADetachedHost()).toEqual([]);
    const mountsAfterRestore = [...gateLifecycle.mounts];
    expect(mountsAfterRestore).toHaveLength(2);

    view.rerender(<ChurnHarness slot="none" />);
    await settle(500);
    expect(screen.queryByTestId('terminal-mount')).toBeNull();
    expect(gateLifecycle.unmounts).toEqual([]);
    expect(gateLifecycle.mounts).toEqual(mountsAfterRestore);

    view.rerender(<ChurnHarness slot="second" />);
    await settle(500);
    const replacementContainer = screen.getByTestId('terminal-mount-second');
    expect(gateLifecycle.unmounts).toEqual([]);
    expect(gateLifecycle.mounts).toEqual(mountsAfterRestore);
    const gatesAfterSwap = screen.getAllByTestId('terminal-gate');
    expect(gatesAfterSwap).toHaveLength(2);
    expect(gatesAfterSwap.filter((gate) => !replacementContainer.contains(gate))).toEqual([]);
    expect(tabTitles()).toEqual(['process second', 'process first']);
    expect(gatesMountedIntoADetachedHost()).toEqual([]);
  });

  test('mounts no agent thread view while the agents portal host is outside the document', async () => {
    openAgentTabs = [
      makeThread({ threadId: 'thread-one', title: 'First thread' }),
      makeThread({
        threadId: 'thread-two',
        title: 'Second thread',
        createdAt: 2,
        lastActivityAt: 2,
      }),
    ];
    render(<AgentsHarness attachContainerAfterMs={2000} />);

    await settle(500);
    expect(screen.queryByTestId('agents-mount')).toBeNull();
    expect(threadViewsMountedIntoADetachedHost()).toEqual([]);

    await settle(3000);
    expect(screen.getAllByTestId('thread-view')).toHaveLength(2);
    expect(threadViewsMountedIntoADetachedHost()).toEqual([]);
  });

  test('terminal host-state records count the terminal strip tabs, not the agent tabs beside it', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    openAgentTabs = [
      makeThread({ threadId: 'thread-one', title: 'First thread' }),
      makeThread({
        threadId: 'thread-two',
        title: 'Second thread',
        createdAt: 2,
        lastActivityAt: 2,
      }),
    ];
    render(
      <>
        <AgentsHarness attachContainerAfterMs={0} />
        <ProducerHarness attachContainerAfterMs={2000} />
      </>,
    );

    await settle(500);
    expect(within(screen.getByTestId('agents-mount')).getAllByRole('tab')).toHaveLength(2);
    expect(screen.queryByTestId('terminal-mount')).toBeNull();

    await settle(3000);
    expect(within(screen.getByTestId('terminal-mount')).getAllByRole('tab')).toHaveLength(2);
    const records = terminalDockHostStateRecords(info.mock.calls);
    const unattachedTabCounts = records
      .filter((record) => !record.attached)
      .map((record) => record.tabs);
    expect(unattachedTabCounts.length).toBeGreaterThan(0);
    expect(unattachedTabCounts).toEqual(unattachedTabCounts.map(() => 0));
    expect(records.at(-1)).toMatchObject({
      attached: true,
      hostConnected: true,
      sessions: 2,
      tabs: 2,
    });
  });

  test('a terminal host-state record keeps the strip tab count after the attached host leaves the document', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const view = render(<ChurnHarness slot="first" />);

    await settle(3000);
    expect(within(screen.getByTestId('terminal-mount')).getAllByRole('tab')).toHaveLength(2);

    view.rerender(<ChurnHarness slot="none" />);
    await settle(500);
    expect(screen.queryByTestId('terminal-mount')).toBeNull();
    expect(terminalDockHostStateRecords(info.mock.calls).at(-1)).toMatchObject({
      attached: true,
      hostConnected: false,
      hasContainer: false,
      sessions: 2,
      tabs: 2,
    });
  });
});
