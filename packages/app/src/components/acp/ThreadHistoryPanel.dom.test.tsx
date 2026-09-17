import type { ThreadInfo } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';

const renameThread = vi.fn((_threadId: string, _title: string) => {});
const deleteThread = vi.fn((_threadId: string) => {});

vi.doMock('@/lib/acp/thread-client', () => ({
  getAgentThreadClient: () => ({ renameThread, deleteThread }),
}));

const { ThreadHistoryPanel, ThreadHistorySearchProvider, ThreadHistoryToggle } = await import(
  './ThreadHistoryPanel'
);

function thread(overrides?: Partial<ThreadInfo>): ThreadInfo {
  return {
    threadId: 't1',
    agent: { id: 'claude-acp', name: 'Claude', source: 'registry' },
    title: 'First prompt title',
    status: 'exited',
    createdAt: 1,
    lastActivityAt: 2,
    lastSeq: 5,
    archived: true,
    ...overrides,
  };
}

function render(ui: Parameters<typeof rtlRender>[0]) {
  return rtlRender(<TooltipProvider>{ui}</TooltipProvider>);
}

function HistoryHarness({
  threads,
  openThreadIds = new Set(),
  activeThreadId = null,
  onSelectThread = () => {},
  scope = 'project-a',
}: {
  threads: readonly ThreadInfo[];
  openThreadIds?: ReadonlySet<string>;
  activeThreadId?: string | null;
  onSelectThread?: (threadId: string) => void;
  scope?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <ThreadHistorySearchProvider scope={scope}>
      <ThreadHistoryToggle open={open} panelId="history-panel-test" onOpenChange={setOpen} />
      {open ? (
        <ThreadHistoryPanel
          threads={threads}
          openThreadIds={openThreadIds}
          activeThreadId={activeThreadId}
          onSelectThread={onSelectThread}
          mode="cover"
          panelId="history-panel-test"
          onDismiss={() => setOpen(false)}
        />
      ) : null}
    </ThreadHistorySearchProvider>
  );
}

async function openMenu(
  openThreadIds: ReadonlySet<string> = new Set(),
  onSelectThread: (threadId: string) => void = () => {},
) {
  render(
    <HistoryHarness
      threads={[thread()]}
      openThreadIds={openThreadIds}
      activeThreadId={null}
      onSelectThread={onSelectThread}
    />,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Chat history' }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  renameThread.mockClear();
  deleteThread.mockClear();
});

describe('ThreadHistoryPanel rename', () => {
  test('cover mode has a back action that dismisses history', async () => {
    await openMenu();

    expect(screen.getByRole('heading', { name: 'Chat history' })).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(screen.queryByTestId('agent-thread-history-panel')).toBeNull();
  });

  test('uses the shared sidebar menu anatomy without file-sidebar state', async () => {
    await openMenu();

    const panel = screen.getByTestId('agent-thread-history-panel');
    const row = screen.getByTestId('agent-thread-history-open-t1');
    const action = screen.getByTestId('agent-thread-history-rename-t1');

    expect(panel.querySelector('[data-sidebar="header"]')).not.toBeNull();
    expect(panel.querySelector('[data-sidebar="content"]')).not.toBeNull();
    expect(panel.querySelector('[data-sidebar="group"]')).not.toBeNull();
    expect(panel.querySelector('[data-sidebar="menu"]')).not.toBeNull();
    expect(row.getAttribute('data-sidebar')).toBe('menu-button');
    expect(row.closest('[data-sidebar="menu-item"]')).not.toBeNull();
    expect(action.closest('[data-sidebar="menu-action"]')).not.toBeNull();
  });

  test('renaming a chat saves on blur and seeds the field with the current title', async () => {
    await openMenu();
    await userEvent.click(screen.getByTestId('agent-thread-history-rename-t1'));

    const input = screen.getByTestId('agent-thread-history-rename-input') as HTMLInputElement;
    expect(input.value).toBe('First prompt title');
    expect(screen.queryByTestId('agent-thread-history-rename-save')).toBeNull();

    await userEvent.clear(input);
    await userEvent.type(input, 'Renamed chat');
    await userEvent.click(screen.getByRole('searchbox', { name: 'Search chat history' }));

    expect(renameThread).toHaveBeenCalledWith('t1', 'Renamed chat');
    expect(screen.queryByTestId('agent-thread-history-rename-input')).toBeNull();
  });

  test('Enter commits and Escape abandons the edit', async () => {
    await openMenu();
    await userEvent.click(screen.getByTestId('agent-thread-history-rename-t1'));
    await userEvent.clear(screen.getByTestId('agent-thread-history-rename-input'));
    await userEvent.type(
      screen.getByTestId('agent-thread-history-rename-input'),
      'Via enter{Enter}',
    );
    expect(renameThread).toHaveBeenCalledWith('t1', 'Via enter');

    await userEvent.click(screen.getByTestId('agent-thread-history-rename-t1'));
    await userEvent.type(screen.getByTestId('agent-thread-history-rename-input'), '{Escape}');
    expect(screen.queryByTestId('agent-thread-history-rename-input')).toBeNull();
    expect(renameThread).toHaveBeenCalledTimes(1);
  });

  test('IME composition does not save or cancel a rename', async () => {
    await openMenu();
    await userEvent.click(screen.getByTestId('agent-thread-history-rename-t1'));
    const input = screen.getByTestId('agent-thread-history-rename-input');

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(renameThread).not.toHaveBeenCalled();
    expect(screen.getByTestId('agent-thread-history-rename-input')).toBe(input);

    fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
    expect(screen.getByTestId('agent-thread-history-rename-input')).toBe(input);
    expect(screen.getByRole('button', { name: 'Chat history' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  test('row actions do not select the conversation', async () => {
    const onSelectThread = vi.fn((_threadId: string) => {});
    await openMenu(new Set(), onSelectThread);

    await userEvent.click(screen.getByTestId('agent-thread-history-rename-t1'));

    expect(onSelectThread).not.toHaveBeenCalled();
  });

  test('a blank name exits rename without replacing the title', async () => {
    await openMenu();
    await userEvent.click(screen.getByTestId('agent-thread-history-rename-t1'));
    await userEvent.clear(screen.getByTestId('agent-thread-history-rename-input'));

    await userEvent.type(screen.getByTestId('agent-thread-history-rename-input'), '{Enter}');
    expect(renameThread).not.toHaveBeenCalled();
    expect(screen.queryByTestId('agent-thread-history-rename-input')).toBeNull();
  });

  test('a chat open as a tab can still be renamed, though it cannot be deleted', async () => {
    await openMenu(new Set(['t1']));

    await userEvent.click(screen.getByTestId('agent-thread-history-rename-t1'));
    await userEvent.clear(screen.getByTestId('agent-thread-history-rename-input'));
    await userEvent.type(
      screen.getByTestId('agent-thread-history-rename-input'),
      'Still renamable{Enter}',
    );
    expect(renameThread).toHaveBeenCalledWith('t1', 'Still renamable');

    await userEvent.click(screen.getByTestId('agent-thread-history-delete-t1'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(deleteThread).not.toHaveBeenCalled();
  });

  test('a live chat keeps a disabled delete action until its tab is closed', async () => {
    render(
      <HistoryHarness
        threads={[thread({ archived: false })]}
        openThreadIds={new Set(['t1'])}
        activeThreadId="t1"
        onSelectThread={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Chat history' }));

    expect(screen.getByTestId('agent-thread-history-rename-t1')).toBeDefined();
    const deleteAction = screen.getByTestId('agent-thread-history-delete-t1');
    expect(deleteAction.getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(deleteAction);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(deleteThread).not.toHaveBeenCalled();
    expect(screen.getByTestId('agent-thread-history-open-t1').getAttribute('aria-current')).toBe(
      'true',
    );
  });

  test('deleting an archived chat requires confirmation in a dialog', async () => {
    const onSelectThread = vi.fn((_threadId: string) => {});
    await openMenu(new Set(), onSelectThread);

    await userEvent.click(screen.getByTestId('agent-thread-history-delete-t1'));

    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByRole('heading', { name: 'Delete chat?' })).toBeDefined();
    expect(dialog.textContent).toContain('First prompt title');
    expect(dialog.textContent).toContain('This action cannot be undone.');
    expect(screen.getByTestId('agent-thread-history-open-t1')).toBeDefined();
    expect(deleteThread).not.toHaveBeenCalled();
    expect(onSelectThread).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(deleteThread).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId('agent-thread-history-delete-t1'));
    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    );
    expect(deleteThread).toHaveBeenCalledWith('t1');
  });
});

function panelTree(mode: 'cover' | 'docked', threads: readonly ThreadInfo[]) {
  return (
    <TooltipProvider>
      <ThreadHistorySearchProvider scope="project-a">
        <ThreadHistoryPanel
          threads={threads}
          openThreadIds={new Set()}
          activeThreadId={null}
          onSelectThread={() => {}}
          mode={mode}
          panelId="history-panel-test"
          onDismiss={() => {}}
        />
      </ThreadHistorySearchProvider>
    </TooltipProvider>
  );
}

describe('ThreadHistoryPanel elapsed time', () => {
  test('relative activity keeps tracking elapsed time while the panel stays mounted', () => {
    vi.useFakeTimers();
    try {
      const start = new Date(2026, 8, 15, 12).getTime();
      vi.setSystemTime(start);
      rtlRender(panelTree('docked', [thread({ lastActivityAt: start })]));

      expect(screen.getByTestId('agent-thread-history-open-t1').textContent).toContain('just now');

      act(() => {
        vi.advanceTimersByTime(120_000);
      });

      expect(screen.getByTestId('agent-thread-history-open-t1').textContent).toContain('2m ago');
    } finally {
      vi.useRealTimers();
    }
  });

  test('a conversation crossing local midnight moves from Today to Older', () => {
    vi.useFakeTimers();
    try {
      const lateLastNight = new Date(2026, 8, 15, 23, 59).getTime();
      vi.setSystemTime(lateLastNight + 10_000);
      rtlRender(panelTree('docked', [thread({ lastActivityAt: lateLastNight })]));

      expect(screen.getByRole('list', { name: 'Today' })).toBeDefined();

      act(() => {
        vi.advanceTimersByTime(60_000);
      });

      expect(screen.queryByRole('list', { name: 'Today' })).toBeNull();
      expect(screen.getByRole('list', { name: 'Older' })).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a presentation-mode change neither moves focus nor commits a pending rename', async () => {
    const threads = [thread()];
    const view = rtlRender(panelTree('docked', threads));

    await userEvent.click(screen.getByTestId('agent-thread-history-rename-t1'));
    const input = screen.getByTestId('agent-thread-history-rename-input') as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, 'Half typed');
    expect(document.activeElement).toBe(input);

    view.rerender(panelTree('cover', threads));

    expect(document.activeElement).toBe(input);
    expect(renameThread).not.toHaveBeenCalled();
    expect(
      (screen.getByTestId('agent-thread-history-rename-input') as HTMLInputElement).value,
    ).toBe('Half typed');
  });
});

describe('ThreadHistoryPanel search', () => {
  test('title matching ignores case and surrounding whitespace across live and archived chats', async () => {
    render(
      <HistoryHarness
        threads={[
          thread({
            threadId: 'live-match',
            title: 'Architecture planning',
            archived: false,
          }),
          thread({
            threadId: 'archived-match',
            title: 'Past ARCHITECTURE review',
          }),
          thread({ threadId: 'nonmatch', title: 'Release checklist' }),
        ]}
        openThreadIds={new Set(['live-match'])}
        activeThreadId="live-match"
        onSelectThread={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Chat history' }));

    await userEvent.type(
      screen.getByRole('searchbox', { name: 'Search chat history' }),
      '  aRcHi  ',
    );

    expect(screen.getByTestId('agent-thread-history-open-live-match')).toBeDefined();
    expect(screen.getByTestId('agent-thread-history-open-archived-match')).toBeDefined();
    expect(screen.queryByTestId('agent-thread-history-open-nonmatch')).toBeNull();
    expect(renameThread).not.toHaveBeenCalled();
    expect(deleteThread).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Clear history search' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search chat history' }), '   ');
    expect(screen.getByTestId('agent-thread-history-open-nonmatch')).toBeDefined();
  });

  test('groups by local calendar date and orders activity with a stable thread tie-break', async () => {
    const now = new Date(2026, 8, 15, 12).getTime();
    const tiedActivity = new Date(2026, 8, 15, 9).getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    render(
      <HistoryHarness
        threads={[
          thread({
            threadId: 'older',
            title: 'Yesterday locally',
            lastActivityAt: new Date(2026, 8, 14, 23, 59).getTime(),
          }),
          thread({ threadId: 'today-b', title: 'Tie B', lastActivityAt: tiedActivity }),
          thread({
            threadId: 'today-newest',
            title: 'Newest today',
            lastActivityAt: new Date(2026, 8, 15, 11).getTime(),
          }),
          thread({ threadId: 'today-a', title: 'Tie A', lastActivityAt: tiedActivity }),
        ]}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Chat history' }));

    const today = screen.getByRole('list', { name: 'Today' });
    const older = screen.getByRole('list', { name: 'Older' });
    expect(
      within(today)
        .getAllByTestId(/^agent-thread-history-open-/)
        .map((row) => row.getAttribute('data-testid')),
    ).toEqual([
      'agent-thread-history-open-today-newest',
      'agent-thread-history-open-today-a',
      'agent-thread-history-open-today-b',
    ]);
    expect(within(older).getByTestId('agent-thread-history-open-older')).toBeDefined();
  });

  test('distinguishes no matches from empty history and clears without changing selection', async () => {
    const onSelectThread = vi.fn((_threadId: string) => {});
    const { rerender } = render(
      <HistoryHarness
        threads={[thread({ lastActivityAt: Date.now() })]}
        activeThreadId="t1"
        onSelectThread={onSelectThread}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Chat history' }));
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('');
    const search = screen.getByRole('searchbox', { name: 'Search chat history' });
    await userEvent.type(search, 'missing title');

    expect(screen.getByRole('heading', { name: 'No chats match your search' })).toBeDefined();
    expect(status.textContent).toBe('No chats match your search');
    expect(screen.queryByRole('heading', { name: 'No chats yet.' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Today' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Older' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Clear history search' }));

    expect((search as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('agent-thread-history-open-t1').getAttribute('aria-current')).toBe(
      'true',
    );
    expect(onSelectThread).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(search);

    rerender(
      <TooltipProvider>
        <HistoryHarness threads={[]} activeThreadId="t1" onSelectThread={onSelectThread} />
      </TooltipProvider>,
    );
    expect(screen.getByRole('status').textContent).toBe('No chats yet.');
  });

  test('keeps an active query while roster title, status, and activity metadata update', async () => {
    const original = [
      thread({ threadId: 'draft', title: 'Draft plan', lastActivityAt: 1 }),
      thread({ threadId: 'release', title: 'Release notes', lastActivityAt: 2 }),
    ];
    const view = render(<HistoryHarness threads={original} />);
    await userEvent.click(screen.getByRole('button', { name: 'Chat history' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search chat history' }), 'release');
    expect(screen.queryByTestId('agent-thread-history-open-draft')).toBeNull();

    view.rerender(
      <TooltipProvider>
        <HistoryHarness
          threads={[
            thread({
              threadId: 'draft',
              title: 'Release plan',
              status: 'running',
              lastActivityAt: 3,
            }),
            original[1],
          ]}
        />
      </TooltipProvider>,
    );

    const rows = screen.getAllByTestId(/^agent-thread-history-open-/);
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
      'agent-thread-history-open-draft',
      'agent-thread-history-open-release',
    ]);
    expect(rows[0]?.textContent).not.toContain('Running');
    expect(
      (screen.getByRole('searchbox', { name: 'Search chat history' }) as HTMLInputElement).value,
    ).toBe('release');
  });
});
