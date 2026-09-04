import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

import type { ParsedCheckpoint, TimelineEntry } from '@inkeep/open-knowledge-core';
import { TooltipProvider } from '@/components/ui/tooltip';

const { TimelineContent } = await import('./TimelinePanel');

const NEWER_SHA = 'a'.repeat(40);
const RECOVERED_SHA = 'c'.repeat(40);

const BRIDGE_MERGE_LOSS: ParsedCheckpoint = {
  kind: 'bridge-merge-loss',
  docName: 'notes',
  size: 12,
  metadata: { lostSubstrings: ['the keystroke'] },
};

function wipEntry(sha: string, author: string): TimelineEntry {
  return {
    sha,
    timestamp: '2026-04-17T00:00:00Z',
    author,
    authorEmail: `${author}@example.test`,
    type: 'wip',
    message: `wip: ${author} edit`,
    contributors: [{ id: author, name: author, docs: ['notes.md'] }],
    checkpoint: null,
  };
}

function recoveredCheckpointEntry(sha: string): TimelineEntry {
  return {
    sha,
    timestamp: '2026-04-17T00:00:00Z',
    author: 'openknowledge',
    authorEmail: 'noreply@openknowledge.local',
    type: 'checkpoint',
    message: 'checkpoint: Before concurrent merge @ 2026-05-05T12:00:00Z',
    contributors: [],
    checkpoint: BRIDGE_MERGE_LOSS,
  };
}

interface RollbackCall {
  body: unknown;
  signal: AbortSignal | null | undefined;
}

interface FetchHarness {
  rollbacks: RollbackCall[];
  release: () => void;
}

function mockTimelineFetch(
  entries: TimelineEntry[],
  { holdRollback = false }: { holdRollback?: boolean } = {},
): FetchHarness {
  const rollbacks: RollbackCall[] = [];
  let resolveHeld: ((res: Response) => void) | undefined;

  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/history')) {
      return Promise.resolve(
        new Response(JSON.stringify({ entries }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    if (url.includes('/api/rollback')) {
      rollbacks.push({
        body: init?.body ? JSON.parse(init.body as string) : null,
        signal: init?.signal,
      });
      if (holdRollback) {
        return new Promise<Response>((resolve) => {
          resolveHeld = resolve;
        });
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  }) as never;

  return {
    rollbacks,
    release: () => resolveHeld?.(new Response(null, { status: 200 })),
  };
}

function renderTimeline() {
  return render(
    <TooltipProvider>
      <TimelineContent docName="notes" />
    </TooltipProvider>,
  );
}

function twoRowHistory(): TimelineEntry[] {
  return [wipEntry(NEWER_SHA, 'Alice'), recoveredCheckpointEntry(RECOVERED_SHA)];
}

async function openConfirmForRecoveredRow() {
  await waitFor(() => expect(screen.getByText('Recovered content')).toBeTruthy());
  fireEvent.click(screen.getAllByTestId('timeline-entry-restore')[1]);
  await screen.findByTestId('timeline-entry-restore-confirm');
}

function restoreButtons(): HTMLButtonElement[] {
  return screen.getAllByTestId('timeline-entry-restore') as HTMLButtonElement[];
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

describe('TimelineContent — restore confirm dismissal leaves the document untouched', () => {
  test('Cancel closes the dialog and issues no rollback', async () => {
    const { rollbacks } = mockTimelineFetch(twoRowHistory());

    renderTimeline();
    await openConfirmForRecoveredRow();
    expect(rollbacks).toHaveLength(0);

    fireEvent.click(screen.getByTestId('timeline-entry-restore-cancel'));

    await waitFor(() => expect(screen.queryByTestId('timeline-entry-restore-confirm')).toBeNull());
    expect(rollbacks).toHaveLength(0);
    expect(restoreButtons()[1].disabled).toBe(false);
  });

  test('Escape closes the dialog and issues no rollback', async () => {
    const { rollbacks } = mockTimelineFetch(twoRowHistory());

    renderTimeline();
    await openConfirmForRecoveredRow();
    expect(rollbacks).toHaveLength(0);

    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByTestId('timeline-entry-restore-confirm')).toBeNull());
    expect(rollbacks).toHaveLength(0);
    expect(restoreButtons()[1].disabled).toBe(false);
  });

  test('re-opening after a dismissal still reaches the rollback (the gate is not one-shot)', async () => {
    const { rollbacks } = mockTimelineFetch(twoRowHistory());

    renderTimeline();
    await openConfirmForRecoveredRow();
    fireEvent.click(screen.getByTestId('timeline-entry-restore-cancel'));
    await waitFor(() => expect(screen.queryByTestId('timeline-entry-restore-confirm')).toBeNull());

    fireEvent.click(restoreButtons()[1]);
    fireEvent.click(await screen.findByTestId('timeline-entry-restore-confirm'));

    await waitFor(() => expect(rollbacks).toHaveLength(1));
    expect(rollbacks[0].body).toEqual({ docName: 'notes', commitSha: RECOVERED_SHA });
  });
});

describe('TimelineContent — the confirm gate is decided by laterEdits', () => {
  test('a row with later edits raises the dialog first; the newest row restores without one', async () => {
    const { rollbacks, release } = mockTimelineFetch(twoRowHistory(), { holdRollback: true });

    renderTimeline();
    await waitFor(() => expect(screen.getByText('Recovered content')).toBeTruthy());

    fireEvent.click(restoreButtons()[1]);
    expect(await screen.findByTestId('timeline-entry-restore-confirm')).toBeTruthy();
    expect(rollbacks).toHaveLength(0);

    fireEvent.click(screen.getByTestId('timeline-entry-restore-cancel'));
    await waitFor(() => expect(screen.queryByTestId('timeline-entry-restore-confirm')).toBeNull());

    fireEvent.click(restoreButtons()[0]);
    expect(rollbacks).toHaveLength(1);
    expect(rollbacks[0].body).toEqual({ docName: 'notes', commitSha: NEWER_SHA });
    expect(screen.queryByTestId('timeline-entry-restore-confirm')).toBeNull();

    release();
    await waitFor(() => expect(restoreButtons()[0].disabled).toBe(false));
  });
});
