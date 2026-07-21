/**
 * Behavioral tests for the sessions dock hosting AGENT THREADS (the unified-dock
 * half of the host). TerminalGate + ThreadView + the thread store are stubbed so
 * the assertions pin what the host owns for thread tabs: mirroring the server
 * thread list into tabs, kind-aware close (archive) + focus (composer), rename →
 * server, and auto-reveal on a new live thread. The terminal half is covered by
 * TerminalDock.dom.test.tsx (same host).
 */

import type { ThreadInfo } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

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

vi.doMock('@/lib/acp/registered-agents', () => ({
  useRegisteredAgents: () => [],
  useDefaultRegisteredAgent: () => null,
  getDefaultRegisteredAgent: () => null,
  registerAgent: () => {},
  // Real code loaded here imports these too (TerminalSessionsHost →
  // pickEffectiveDefaultAgent; catalog → hydrateRegisteredAgentMeta). A
  // mock.module replaces the whole module, so any omitted export becomes an
  // unresolved import that fails the file (and can cascade to siblings).
  pickEffectiveDefaultAgent: () => null,
  hydrateRegisteredAgentMeta: () => {},
}));

const launchAgentThread = vi.fn(() => {});
vi.doMock('@/lib/acp/launch-agent-thread', () => ({ launchAgentThread }));

let catalogData: unknown;
// The host and New split-button share the catalog query; keep it controllable.
vi.doMock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: catalogData, isLoading: false, isError: false }),
}));

const { TerminalSessionsHost } = await import('./TerminalSessionsHost');

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
      <TerminalSessionsHost
        bridge={bridge}
        visible={visible}
        onVisibleChange={(v) => {
          onVisibleChange?.(v);
          setVisible(v);
        }}
        installedClis={{}}
        container={container}
        isShowing={visible && container != null}
        onRequestEditorFocus={() => {}}
        dockPosition="bottom"
      />
    </TooltipProvider>
  );
}

describe('TerminalSessionsHost — agent-thread hosting (web / no bridge)', () => {
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
  });
  afterEach(() => cleanup());

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
