import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThreadCard } from './ThreadCard';
import type { CommentThread } from './types';

const NOW = new Date(2026, 7, 5, 12, 0, 0).getTime();
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function renderEdited(updatedAt: number) {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  const thread: CommentThread = {
    id: 't1',
    docName: 'recipes/radishes',
    target: { kind: 'body' },
    anchor: { quote: '2 bunches radishes', prefix: '', suffix: '', start: 0, end: 18 },
    status: 'open',
    body: 'sfcs',
    createdAt: NOW - 400 * DAY,
    updatedAt,
    queued: true,
  };
  return render(
    <TooltipProvider>
      <ThreadCard
        thread={thread}
        cardRef={() => {}}
        focused={false}
        active={false}
        sending={false}
      />
    </TooltipProvider>,
  );
}

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the last-edited stamp', () => {
  test('prints the time alone for a comment edited today', () => {
    const at = NOW - 3 * HOUR;
    renderEdited(at);
    expect(screen.getByText(timeOf(at))).toBeTruthy();
  });

  test('adds the date once it is not today', () => {
    const at = NOW - 3 * DAY;
    renderEdited(at);
    expect(screen.queryByText(timeOf(at))).toBeNull();
    expect(screen.getByText(/Aug 2/)).toBeTruthy();
  });

  test('adds the year only outside this one', () => {
    renderEdited(NOW - 400 * DAY);
    expect(screen.getByText(/2025/)).toBeTruthy();
  });

  test('follows the revision, not the creation', () => {
    const at = NOW - HOUR;
    renderEdited(at);
    expect(screen.getByText(timeOf(at))).toBeTruthy();
    expect(screen.queryByText(/2025/)).toBeNull();
  });
});
