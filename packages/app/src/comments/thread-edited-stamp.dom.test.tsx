/**
 * The card's last-edited stamp.
 *
 * A clock time, not an age. Two things it has to get right: how much date to
 * print (none today, no year this year), and WHICH time it prints — the stamp
 * follows the comment's newest revision, so an edited comment stops reading as
 * the moment it was first written.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThreadCard } from './ThreadCard';
import type { CommentThread } from './types';

/** Local time on purpose: the stamp's today-or-not branch is a local-day test. */
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
  // The card's hints are shadcn Tooltips, which Radix requires a provider for.
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
    // The time alone would be ambiguous across days, so it must not stand alone.
    expect(screen.queryByText(timeOf(at))).toBeNull();
    expect(screen.getByText(/Aug 2/)).toBeTruthy();
  });

  test('adds the year only outside this one', () => {
    renderEdited(NOW - 400 * DAY);
    expect(screen.getByText(/2025/)).toBeTruthy();
  });

  test('follows the revision, not the creation', () => {
    // The whole reason `updatedAt` exists: this thread was written over a year
    // ago (see `createdAt` above) and revised an hour ago.
    const at = NOW - HOUR;
    renderEdited(at);
    expect(screen.getByText(timeOf(at))).toBeTruthy();
    expect(screen.queryByText(/2025/)).toBeNull();
  });
});
