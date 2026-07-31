/**
 * Behavioral tests for the AGENTS PANEL surface of the shared session host.
 * TerminalGate + ThreadView + the thread store are stubbed so the assertions pin
 * what the host owns for thread tabs: mirroring the server thread list into tabs,
 * close (archive) + focus (composer), rename → server, and auto-reveal on a new
 * live thread. The terminal surface is covered by TerminalDock.dom.test.tsx (same
 * component, different `surface`).
 *
 * The "Ask AI honors the preferred AI" block below is the regression guard for
 * the cross-panel arbitration: both docked hosts resolve the SAME preferred AI
 * from global capabilities, and each answers only for the kinds it owns. These
 * tests assert the agents panel takes `thread` and `none`, and declines `cli`
 * (which the terminal dock picks up off the same event).
 */

import type { ThreadInfo } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { subscribeStagedThreadDraft } from '@/lib/acp/thread-draft-staging';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { requestPreferredSession } from './handoff/preferred-session-events';
import { requestActiveTerminalInput } from './handoff/terminal-input-events';
import { subscribeToTerminalLaunchRequests } from './handoff/terminal-launch-events';
import { _resetReusableSession, getReusableSession } from './reusable-session-store';

// A tiny controllable stand-in for the server-authoritative thread store.
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
// Reopening an archived thread adds it to the open set (it stays archived).
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
  getAgentThreadClient: () => ({ closeThread, renameThread, openArchivedThread, deleteThread }),
}));

// ThreadView is lazy-loaded by the host; stub it (with the composer focus hook).
vi.doMock('@/components/acp/ThreadView', () => ({
  ThreadView: ({ info }: { info: ThreadInfo }) => (
    <div data-testid="thread-view" data-thread-id={info.threadId}>
      <textarea data-testid="agent-thread-composer" />
    </div>
  ),
}));

/**
 * The registered in-app agent, when a test wants one. Null (the default) models a
 * machine with no ACP agent set up, so the launcher falls through to the CLI /
 * bare-terminal families.
 */
let mockRegisteredAgent: { source: 'registry' | 'custom'; id: string; name: string } | null = null;

vi.doMock('@/lib/acp/registered-agents', () => ({
  useRegisteredAgents: () => (mockRegisteredAgent === null ? [] : [mockRegisteredAgent]),
  useDefaultRegisteredAgent: () => mockRegisteredAgent,
  getDefaultRegisteredAgent: () => mockRegisteredAgent,
  registerAgent: () => {},
  // Real code loaded here imports these too (SessionsHost →
  // pickEffectiveDefaultAgent; catalog → hydrateRegisteredAgentMeta). A
  // mock.module replaces the whole module, so any omitted export becomes an
  // unresolved import that fails the file (and can cascade to siblings).
  pickEffectiveDefaultAgent: () => mockRegisteredAgent,
  hydrateRegisteredAgentMeta: () => {},
}));

const launchAgentThread = vi.fn(() => {});
vi.doMock('@/lib/acp/launch-agent-thread', () => ({ launchAgentThread }));

let catalogData: unknown;
// The host and New split-button share the catalog query; keep it controllable.
vi.doMock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: catalogData, isLoading: false, isError: false }),
}));

const { SessionsHost } = await import('./SessionsHost');

/** Two distinguishable agents, so a stale publish names a visibly wrong one. */
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

/** Minimal desktop bridge whose only job is to make `terminalAvailable` true, so
 *  the CLI family is a candidate the launcher can resolve to. */
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

function Harness({
  bridge = null,
  initialVisible = true,
  onVisibleChange,
}: {
  bridge?: OkDesktopBridge | null;
  initialVisible?: boolean;
  onVisibleChange?: (v: boolean) => void;
}) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(initialVisible);
  return (
    <TooltipProvider>
      <div ref={setContainer} data-testid="dock-container" />
      <SessionsHost
        surface="agents-panel"
        bridge={bridge}
        // The agents panel reads terminal capability for the GLOBAL Ask-AI
        // resolution only — it never spawns a PTY itself. Mirrors EditorPane,
        // which hands both hosts the same whole-app fact.
        terminalCapable={bridge != null}
        visible={visible}
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
    catalogData = undefined;
    mockRegisteredAgent = null;
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
    // No default agent → "Start an agent"; the click opens Configure agents
    // rather than launching an agent directly (the catalog was retired).
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

    // Remove t1 from the store (archived elsewhere) → its tab drops.
    setOpenThreads([makeThread({ threadId: 't2', title: 'Two' })]);
    await waitFor(() => expect(screen.queryByRole('tab', { name: /One/ })).toBeNull());
    expect(screen.getByRole('tab', { name: /Two/ })).toBeDefined();
  });

  test('the appendable-session signal names the ACTIVE tab, not the previous one', async () => {
    // Regression: the publish effect read `activeSessionIdRef` / `sessionsRef`,
    // which are synced by an effect declared BELOW it — so it saw the previous
    // commit and published the tab you just switched AWAY from. The queue's
    // send button reads this to name its destination, so the symptom was
    // "Send → Cursor" while sitting in Claude Agent.
    render(<Harness />);
    setOpenThreads([makeThread({ threadId: 't1', title: 'One', agent: FIRST_AGENT })]);
    await screen.findByRole('tab', { name: /One/ });
    await waitFor(() => expect(getReusableSession()?.label).toBe('First Agent'));

    // A second thread arrives and auto-reveals as the active tab.
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

    // Archived threads (history) must never pop a dock the user closed.
    setOpenThreads([makeThread({ threadId: 't1', title: 'History', archived: true })]);

    await new Promise((r) => setTimeout(r, 50));
    expect(onVisibleChange).not.toHaveBeenCalledWith(true);
  });

  test('the history menu reopens an archived conversation as a tab', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    // One live tab (so the strip renders) + archived history to return to.
    setOpenThreads([makeThread({ threadId: 'live', title: 'Live' })]);
    setArchivedThreads([makeThread({ threadId: 'arch', title: 'Old chat', archived: true })]);
    await screen.findByRole('tab', { name: /Live/ });

    await user.click(screen.getByRole('button', { name: 'Restore sessions' }));
    await user.click(await screen.findByTestId('agent-thread-history-open-arch'));

    expect(openArchivedThread).toHaveBeenCalledWith('arch');
    // The store reopen brought it in as a tab.
    expect(await screen.findByRole('tab', { name: /Old chat/ })).toBeDefined();
  });

  test('the restore and delete controls explain themselves on hover', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    setOpenThreads([makeThread({ threadId: 'live', title: 'Live' })]);
    setArchivedThreads([makeThread({ threadId: 'arch', title: 'Old chat', archived: true })]);
    await screen.findByRole('tab', { name: /Live/ });

    const restore = screen.getByRole('button', { name: 'Restore sessions' });
    await user.hover(restore);
    expect((await screen.findByRole('tooltip')).textContent).toContain('Restore sessions');

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

    await user.click(screen.getByRole('button', { name: 'Restore sessions' }));
    await user.click(await screen.findByTestId('agent-thread-history-delete-arch'));
    // Delete is confirm-gated (no undo) — the first click only arms it.
    expect(deleteThread).not.toHaveBeenCalled();
    await user.click(await screen.findByTestId('agent-thread-history-confirm-delete'));

    expect(deleteThread).toHaveBeenCalledWith('arch');
  });

  test('an empty dock offers a chooser to reopen a past conversation', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    // No open sessions, but archived history exists → the chooser, not a dead end.
    setArchivedThreads([makeThread({ threadId: 'arch', title: 'Yesterday', archived: true })]);

    await user.click(await screen.findByTestId('agent-thread-empty-open-arch'));

    expect(openArchivedThread).toHaveBeenCalledWith('arch');
    expect(await screen.findByRole('tab', { name: /Yesterday/ })).toBeDefined();
  });

  test('the history menu is absent with no archived history', () => {
    render(<Harness />);
    setOpenThreads([makeThread({ threadId: 'live', title: 'Live' })]);
    expect(screen.queryByRole('button', { name: 'Restore sessions' })).toBeNull();
  });

  // Every "Ask AI" surface (Problems panel, selection bubble, code block, ⌘J/⇧⌘J)
  // funnels through this one channel, and the host is the only place that knows
  // which AI the user prefers — so the preferred agent, CLI, or bare shell is what
  // each surface routes to, uniformly.
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

      // The passage lands as `prompt` (2nd arg), so the thread runs it on
      // creation — the thread twin of a fresh CLI baking the prompt as an arg.
      // Nothing is staged.
      expect(launchAgentThread).toHaveBeenCalledTimes(1);
      const [agent, prompt, , , stagedDraft] = launchAgentThread.mock.calls[0];
      expect(agent).toEqual({ source: 'registry', id: 'acme-agent' });
      expect(prompt).toBe('fix this lint error');
      expect(stagedDraft).toBeNull();
      // Crucially: no terminal launch at all. This is the assertion that fails
      // against the old hardcoded `requestTerminalLaunch(text, 'claude')`.
      expect(launches).toEqual([]);
    });

    test('a ⌘J selection send STAGES on a new thread instead of running', async () => {
      mockRegisteredAgent = { source: 'registry', id: 'acme-agent', name: 'Acme' };
      render(<Harness />);
      await screen.findByTestId('terminal-new-chat');

      await act(async () => {
        requestActiveTerminalInput('a selected passage', { submit: false });
      });

      // Raw material, so it waits on the user's send — mirroring the terminal,
      // where a selection send rides `stagePaste` and never auto-runs.
      expect(launchAgentThread).toHaveBeenCalledTimes(1);
      const [, prompt, , , stagedDraft] = launchAgentThread.mock.calls[0];
      expect(prompt).toBeNull();
      expect(stagedDraft).toBe('a selected passage');
    });

    // Reuse never submits on EITHER family. Not a choice made for threads: it is
    // what `terminal.input` has always done (write, don't press enter).
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
      // Seeded BEFORE mount so the live count never increases — the auto-reveal
      // that covers a fresh thread cannot fire, which is exactly the state a
      // user is in after collapsing a dock they had been working in.
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

      // The draft lands in the session AND the dock comes back, so the send is
      // visibly a send. Staging into a hidden surface reads as a no-op.
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
      // Both positions, matching the sibling above: asserting the draft alone
      // would still pass if a caller set BOTH prompt and stageDraft, which would
      // auto-run the passage the user only highlighted.
      expect(launchAgentThread).toHaveBeenCalledTimes(1);
      const [, prompt, , , stagedDraft] = launchAgentThread.mock.calls[0];
      expect(prompt).toBeNull();
      expect(stagedDraft).toBe('a fresh question');
    });

    // The other half of the matrix: an Ask AI INSTRUCTION that forces a fresh
    // session (a Problems-panel ask dispatched while a thread is already open).
    // Skips reuse like the case above, but `submit` sends it to `prompt`.
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

    // Closes the triangle: the channel and `launchSelectedNewTab` are each tested
    // alone, but nothing fired a request into a mounted host. A stale closure or an
    // event-name drift would slip past both endpoint tests.
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

    // The other half of the ⇧⌘J partition: no in-app agent means the preferred AI
    // is a CLI or a shell, both of which belong to the terminal dock. Declining
    // here is what stops the two panels each opening a session for one press.
    test('a promptless preferred-session request is left to the terminal dock with no agent', async () => {
      render(<Harness bridge={makeTerminalBridge()} />);
      await screen.findByTestId('terminal-new-chat');

      await act(async () => {
        requestPreferredSession();
      });

      expect(launchAgentThread).not.toHaveBeenCalled();
    });

    // Arbitration, the half this panel owns: with no in-app agent the preferred
    // AI resolves to a CLI, which belongs to the TERMINAL dock. This panel must
    // decline outright rather than launch one — a CLI started from here would
    // have no PTY surface to live in, and the terminal dock (answering the same
    // event, with the same resolution) would open a second one. The answering
    // half is asserted in TerminalDock.dom.test.tsx.
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

      // Nothing at all: no thread, no CLI launch of its own, and — the part a
      // silent mis-claim would break — no reveal of a panel that has no answer.
      expect(launchAgentThread).not.toHaveBeenCalled();
      expect(launches).toEqual([]);
      expect(onVisibleChange).not.toHaveBeenCalled();
    });

    test('with nothing set up, an Ask AI send opens Configure agents (no silent shell)', async () => {
      // No registered agent and no terminal host → nothing to ask. The passage
      // routes to Settings rather than silently opening a bare shell or a
      // hardcoded CLI, matching the New primary's destination in this state.
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

  test('a dropped WS shows the reconnecting banner above the active thread', async () => {
    render(<Harness />);
    setOpenThreads([makeThread({ threadId: 't1', title: 'Work' })]);
    await screen.findByTestId('thread-view');

    // Healthy channel: no banner.
    expect(screen.queryByTestId('agent-thread-reconnecting')).toBeNull();

    // WS drops → the reconnecting feedback appears.
    setConnectionStatus('closed');
    expect(await screen.findByTestId('agent-thread-reconnecting')).toBeDefined();

    // Recovered → it clears.
    setConnectionStatus('open');
    await waitFor(() => expect(screen.queryByTestId('agent-thread-reconnecting')).toBeNull());
  });
});
