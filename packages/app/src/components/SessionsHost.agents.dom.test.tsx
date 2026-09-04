import type { ThreadInfo } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
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

let openThreads: ThreadInfo[] = [];
const storeListeners = new Set<() => void>();
let archivedThreads: ThreadInfo[] = [];
function notifyStore() {
  for (const l of storeListeners) l();
}
function setOpenThreads(next: ThreadInfo[]) {
  openThreads = next;
  notifyStore();
}
function setArchivedThreads(next: ThreadInfo[]) {
  archivedThreads = next;
  notifyStore();
}
const closeThread = vi.fn((_id: string) => {});
const renameThread = vi.fn((_id: string, _title: string) => {});
const openArchivedThread = vi.fn((id: string) => {
  const thread = archivedThreads.find((t) => t.threadId === id);
  if (thread != null) setOpenThreads([...openThreads, thread]);
});
const deleteThread = vi.fn((id: string) => {
  setArchivedThreads(archivedThreads.filter((t) => t.threadId !== id));
});

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
  useOpenAgentThreadTabs: () =>
    useSyncExternalStore(
      subscribeStore,
      () => openThreads,
      () => openThreads,
    ),
  useArchivedAgentThreads: () =>
    useSyncExternalStore(
      subscribeStore,
      () => archivedThreads,
      () => archivedThreads,
    ),
  useAgentThreadConnection: () =>
    useSyncExternalStore(
      subscribeStore,
      () => connectionStatus,
      () => connectionStatus,
    ),
  useAgentThreadUnread: () => false,
  getAgentThreadClient: () => ({
    closeThread,
    renameThread,
    openArchivedThread,
    deleteThread,
    markThreadViewed: () => {},
  }),
}));

vi.doMock('@/components/acp/ThreadView', () => ({
  ThreadView: ({ info }: { info: ThreadInfo }) => (
    <div data-testid="thread-view" data-thread-id={info.threadId}>
      <textarea data-testid="agent-thread-composer" />
    </div>
  ),
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
vi.doMock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: catalogData, isLoading: false, isError: false }),
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
  rerender: () => void;
};

function makeControl(): { current: HarnessControl | null } {
  return { current: null };
}

function Harness({
  bridge = null,
  initialVisible = true,
  onVisibleChange,
  threadLaunch: initialThreadLaunch = null,
  control,
}: {
  bridge?: OkDesktopBridge | null;
  initialVisible?: boolean;
  onVisibleChange?: (v: boolean) => void;
  threadLaunch?: ThreadLaunchIntent | null;
  control?: { current: HarnessControl | null };
}) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(initialVisible);
  const [threadLaunch, setThreadLaunch] = useState(initialThreadLaunch);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (control != null)
      control.current = { setVisible, setThreadLaunch, rerender: () => setTick((n) => n + 1) };
  }, [control]);
  return (
    <TooltipProvider>
      <div ref={setContainer} data-testid="dock-container" />
      <SessionsHost
        surface="agents-panel"
        bridge={bridge}
        terminalCapable={bridge != null}
        visible={visible}
        threadLaunch={threadLaunch}
        onVisibleChange={(v) => {
          onVisibleChange?.(v);
          setVisible(v);
        }}
        installedClis={{}}
        container={container}
        isShowing={visible && container != null}
        onRequestEditorFocus={() => {}}
      />
    </TooltipProvider>
  );
}

describe('SessionsHost — agents panel (web / no bridge)', () => {
  beforeEach(() => {
    openThreads = [];
    archivedThreads = [];
    connectionStatus = 'open';
    closeThread.mockClear();
    renameThread.mockClear();
    openArchivedThread.mockClear();
    deleteThread.mockClear();
    launchAgentThread.mockClear();
    mockLaunchOutcome = 'started';
    toastError.mockClear();
    mockInflightLaunch = false;
    registerAgent.mockClear();
    catalogData = undefined;
    mockRegisteredAgent = null;
    mockPersistedDefaultAgent = null;
    localStorage.clear();
    reloadEnabledAgentsFromStorage();
  });
  afterEach(() => {
    cleanup();
    _resetReusableSession();
  });

  test('a server thread becomes a tab rendering its ThreadView', async () => {
    render(<Harness />);
    setOpenThreads([makeThread({ threadId: 't1', title: 'Refactor' })]);

    expect(await screen.findByRole('tab', { name: /Refactor/ })).toBeDefined();
    expect(await screen.findByTestId('thread-view')).toBeDefined();
  });

  test('without an explicit default the primary reads "Start an agent" and opens Settings', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const button = await screen.findByTestId('terminal-new-chat');
    expect(button.getAttribute('aria-label')).toBe('Start an agent');
    await user.click(button);

    expect(launchAgentThread).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#settings/configure-agents');
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
    expect(onVisibleChange).not.toHaveBeenCalledWith(true);
  });

  test('the history menu reopens an archived conversation as a tab', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    setOpenThreads([makeThread({ threadId: 'live', title: 'Live' })]);
    setArchivedThreads([makeThread({ threadId: 'arch', title: 'Old chat', archived: true })]);
    await screen.findByRole('tab', { name: /Live/ });

    await user.click(screen.getByRole('button', { name: 'Reopen a past chat' }));
    await user.click(await screen.findByTestId('agent-thread-history-open-arch'));

    expect(openArchivedThread).toHaveBeenCalledWith('arch');
    expect(await screen.findByRole('tab', { name: /Old chat/ })).toBeDefined();
  });

  test('the restore and delete controls explain themselves on hover', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    setOpenThreads([makeThread({ threadId: 'live', title: 'Live' })]);
    setArchivedThreads([makeThread({ threadId: 'arch', title: 'Old chat', archived: true })]);
    await screen.findByRole('tab', { name: /Live/ });

    const restore = screen.getByRole('button', { name: 'Reopen a past chat' });
    await user.hover(restore);
    expect((await screen.findByRole('tooltip')).textContent).toContain('Reopen a past chat');

    await user.click(restore);
    const deleteButton = await screen.findByRole('button', { name: 'Delete Old chat' });
    await user.hover(deleteButton);
    expect((await screen.findByRole('tooltip')).textContent).toContain('Delete Old chat');
  });

  test('the history menu deletes an archived conversation behind an inline confirm', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    setOpenThreads([makeThread({ threadId: 'live', title: 'Live' })]);
    setArchivedThreads([makeThread({ threadId: 'arch', title: 'Old chat', archived: true })]);
    await screen.findByRole('tab', { name: /Live/ });

    await user.click(screen.getByRole('button', { name: 'Reopen a past chat' }));
    await user.click(await screen.findByTestId('agent-thread-history-delete-arch'));
    expect(deleteThread).not.toHaveBeenCalled();
    await user.click(await screen.findByTestId('agent-thread-history-confirm-delete'));

    expect(deleteThread).toHaveBeenCalledWith('arch');
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

    await user.click(screen.getByRole('button', { name: 'Reopen a past chat' }));
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
    expect(screen.queryByTestId('agent-thread-history-confirm')).toBeNull();
    expect(screen.queryByTestId('agent-thread-history-confirm-delete')).toBeNull();
    expect(deleteThread).not.toHaveBeenCalled();

    expect(screen.getByTestId('agent-thread-history-open-arch')).toHaveProperty('disabled', false);
  });

  test('an archived conversation with no open tab is still deletable', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    setOpenThreads([makeThread({ threadId: 'live', title: 'Live' })]);
    setArchivedThreads([makeThread({ threadId: 'cold', title: 'Cold chat', archived: true })]);
    await screen.findByRole('tab', { name: /Live/ });

    await user.click(screen.getByRole('button', { name: 'Reopen a past chat' }));
    const coldDelete = await screen.findByTestId('agent-thread-history-delete-cold');
    expect(coldDelete.getAttribute('aria-disabled')).toBeNull();
    expect(coldDelete.getAttribute('aria-describedby')).toBeNull();

    await user.click(coldDelete);
    await user.click(await screen.findByTestId('agent-thread-history-confirm-delete'));
    expect(deleteThread).toHaveBeenCalledWith('cold');
  });

  test('an empty dock offers a chooser to reopen a past conversation', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    setArchivedThreads([makeThread({ threadId: 'arch', title: 'Yesterday', archived: true })]);

    await user.click(await screen.findByTestId('agent-thread-empty-open-arch'));

    expect(openArchivedThread).toHaveBeenCalledWith('arch');
    expect(await screen.findByRole('tab', { name: /Yesterday/ })).toBeDefined();
  });

  test('the history menu is absent with no archived history', () => {
    render(<Harness />);
    setOpenThreads([makeThread({ threadId: 'live', title: 'Live' })]);
    expect(screen.queryByRole('button', { name: 'Reopen a past chat' })).toBeNull();
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
      expect(window.location.hash).toBe('#settings/configure-agents');
    });
  });

  describe('pickerless thread launch', () => {
    const sentinelLaunch = (nonce: number): ThreadLaunchIntent => ({
      agentSource: 'registry',
      agentId: '',
      prompt: null,
      docName: null,
      titleHint: null,
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
      ]);
      expect(window.location.hash).toBe('');
      expect(registerAgent).not.toHaveBeenCalled();
    });

    test('with nothing enabled it still opens Configure agents', () => {
      window.location.hash = '';
      mockRegisteredAgent = null;
      render(<Harness threadLaunch={sentinelLaunch(1)} />);

      expect(launchAgentThread).not.toHaveBeenCalled();
      expect(window.location.hash).toBe('#settings/configure-agents');
    });

    test('an agent the user disabled is never what a pickerless launch leads with', () => {
      window.location.hash = '';
      mockRegisteredAgent = { source: 'registry', id: 'claude-acp', name: 'Claude Agent' };
      setAgentEnabled(inAppEnabledKey('registry', 'claude-acp'), false);
      render(<Harness threadLaunch={sentinelLaunch(1)} />);

      expect(launchAgentThread).not.toHaveBeenCalled();
      expect(window.location.hash).toBe('#settings/configure-agents');
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
      expect(window.location.hash).toBe('#settings/configure-agents');
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
      expect(window.location.hash).toBe('#settings/configure-agents');

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
      expect(window.location.hash).toBe('#settings/configure-agents');

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

    test('the seed keys on the reveal transition, not on being visible', () => {
      window.location.hash = '';
      mockRegisteredAgent = { source: 'registry', id: 'claude-acp', name: 'Claude Agent' };
      render(<Harness initialVisible />);

      expect(launchAgentThread).not.toHaveBeenCalled();
      expect(window.location.hash).toBe('');
    });

    test('revealing an empty panel with no agent available stays empty and never opens the catalog', () => {
      window.location.hash = '';
      mockRegisteredAgent = null;
      const control = makeControl();
      render(<Harness initialVisible={false} control={control} />);

      act(() => control.current?.setVisible(true));

      expect(launchAgentThread).not.toHaveBeenCalled();
      expect(window.location.hash).toBe('');
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
