import type { ThreadInfo } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { cleanup, render as rtlRender, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';

const renameThread = vi.fn((_threadId: string, _title: string) => {});
const deleteThread = vi.fn((_threadId: string) => {});

vi.doMock('@/lib/acp/thread-client', () => ({
  getAgentThreadClient: () => ({ renameThread, deleteThread }),
}));

const { ThreadHistoryMenu } = await import('./ThreadHistoryMenu');

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

async function openMenu(openThreadIds: ReadonlySet<string> = new Set()) {
  render(
    <ThreadHistoryMenu
      archived={[thread()]}
      openThreadIds={openThreadIds}
      onOpenThread={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Reopen a past chat' }));
}

afterEach(() => {
  cleanup();
  renameThread.mockClear();
  deleteThread.mockClear();
});

describe('ThreadHistoryMenu rename', () => {
  test('renaming a chat sends the new title and seeds the field with the current one', async () => {
    await openMenu();
    await userEvent.click(screen.getByTestId('agent-thread-history-rename-t1'));

    const input = screen.getByTestId('agent-thread-history-rename-input') as HTMLInputElement;
    expect(input.value).toBe('First prompt title');

    await userEvent.clear(input);
    await userEvent.type(input, 'Renamed chat');
    await userEvent.click(screen.getByTestId('agent-thread-history-rename-save'));

    expect(renameThread).toHaveBeenCalledWith('t1', 'Renamed chat');
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

  test('a blank name cannot be saved, rather than silently doing nothing', async () => {
    await openMenu();
    await userEvent.click(screen.getByTestId('agent-thread-history-rename-t1'));
    await userEvent.clear(screen.getByTestId('agent-thread-history-rename-input'));

    expect(
      (screen.getByTestId('agent-thread-history-rename-save') as HTMLButtonElement).disabled,
    ).toBe(true);

    await userEvent.type(screen.getByTestId('agent-thread-history-rename-input'), '{Enter}');
    expect(renameThread).not.toHaveBeenCalled();
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
    expect(screen.queryByTestId('agent-thread-history-confirm')).toBeNull();
    expect(deleteThread).not.toHaveBeenCalled();
  });
});
