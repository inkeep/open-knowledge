/**
 * RTL mount test: the full-pane version diff's OWN Restore control — the
 * second restore surface, reached by opening a Timeline row's diff rather than
 * clicking the row's inline restore icon.
 *
 * It repeats the whole journey the Timeline row owns, on its own state: the
 * confirm gate keyed on `laterEdits`, the POST /api/rollback for the viewed
 * version's sha (never the parent's), the Cancel and Escape dismissals, and the
 * dismissal of the pane itself once the restore lands.
 *
 * Escape is load-bearing twice over here: the pane binds its own window-level
 * Escape-to-close, so Escape while the confirm is up must dismiss the dialog
 * ONLY — dropping the whole pane would discard the user's place in the diff on
 * a keystroke they aimed at the dialog.
 *
 * Stubbed seams: `fetch` (the /api/history version loads plus the rollback
 * endpoint) and the document context the diff hook reads its live-text provider
 * from — the pane diffs vs-parent, so both sides are historical fetches and the
 * provider is never consulted. Everything else is the real component.
 *
 * Invocation: `pnpm run test:dom` from `packages/app/`.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Hoisted above every import: the SUT's transitive `useTheme` and its document
// context bind to these stubs rather than the real providers.
vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));
vi.mock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ activeProvider: null, activeDocName: 'notes' }),
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import {
  closeTimelineDiff,
  openTimelineDiff,
  type TimelineDiffView,
  useTimelineDiffView,
} from '@/lib/timeline-diff-store';

const { TimelineDiffPane } = await import('./TimelineDiffPane');

const VERSION_SHA = 'c'.repeat(40);
const PARENT_SHA = 'p'.repeat(40);
const PARENT_BODY = 'first line\nsecond line\n';
const VERSION_BODY = 'first line\nsecond line rewritten\n';

function viewFor(laterEdits: number): TimelineDiffView {
  return {
    docName: 'notes',
    sha: VERSION_SHA,
    parentSha: PARENT_SHA,
    laterEdits,
    authorName: 'Alice',
    relativeTime: '2 hours ago',
    absoluteTime: '2026-04-17 00:00',
  };
}

interface RollbackCall {
  body: unknown;
  signal: AbortSignal | null | undefined;
}

interface FetchHarness {
  /** Every POST /api/rollback the pane issued, in order. */
  rollbacks: RollbackCall[];
  /** Resolve a held rollback response (no-op when none is held). */
  release: () => void;
}

/**
 * Serve both historical version loads and record every rollback.
 * `holdRollback` leaves the rollback response pending so a test can inspect the
 * pane while the request is genuinely in flight.
 */
function mockDiffFetch({ holdRollback = false }: { holdRollback?: boolean } = {}): FetchHarness {
  const rollbacks: RollbackCall[] = [];
  let resolveHeld: ((res: Response) => void) | undefined;

  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes(`/api/history/${VERSION_SHA}`)) {
      return Promise.resolve(
        new Response(JSON.stringify({ content: VERSION_BODY }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    if (url.includes(`/api/history/${PARENT_SHA}`)) {
      return Promise.resolve(
        new Response(JSON.stringify({ content: PARENT_BODY }), {
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

/**
 * Reports whether the diff overlay is still claimed by the store — the same
 * signal EditorArea paints the pane from, so it is how a user would perceive
 * "the diff is still open".
 */
function DiffStoreProbe() {
  const view = useTimelineDiffView();
  return <span data-testid="diff-store-state">{view === null ? 'closed' : 'open'}</span>;
}

function renderPane(laterEdits: number) {
  const view = viewFor(laterEdits);
  openTimelineDiff(view);
  return render(
    <TooltipProvider>
      <DiffStoreProbe />
      <TimelineDiffPane view={view} isPanelCollapsed={false} onTogglePanel={() => {}} />
    </TooltipProvider>,
  );
}

/** Wait for both historical loads to land so the diff body is painted. */
async function waitForDiffBody() {
  await waitFor(() => expect(screen.queryByText('Loading diff')).toBeNull());
}

function restoreButton(): HTMLButtonElement {
  return screen.getByTestId('timeline-diff-restore') as HTMLButtonElement;
}

function storeState(): string {
  return screen.getByTestId('diff-store-state').textContent ?? '';
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  closeTimelineDiff();
  cleanup();
});

describe('TimelineDiffPane — its own Restore reaches the rollback', () => {
  test('confirming restores the VIEWED version, not its diff baseline', async () => {
    const { rollbacks } = mockDiffFetch();

    renderPane(2);
    await waitForDiffBody();

    fireEvent.click(restoreButton());

    // The confirm gates the restore — nothing has left yet.
    const confirm = await screen.findByTestId('timeline-diff-restore-confirm');
    expect(rollbacks).toHaveLength(0);

    fireEvent.click(confirm);

    await waitFor(() => expect(rollbacks).toHaveLength(1));
    // The pane holds two shas; the rollback target is the one being viewed.
    expect(rollbacks[0].body).toEqual({ docName: 'notes', commitSha: VERSION_SHA });
    // A landed restore dismisses the diff overlay — the user is returned to the
    // editor showing the restored document.
    await waitFor(() => expect(storeState()).toBe('closed'));
  });

  test('the newest version restores without a confirm; an older one always raises it', async () => {
    // Held rollback: both halves are asserted while the request state is still
    // observable, rather than after a resolution has torn the dialog down.
    const zeroLater = mockDiffFetch({ holdRollback: true });
    renderPane(0);
    await waitForDiffBody();

    fireEvent.click(restoreButton());
    // Nothing to roll back, so the request leaves synchronously on click with
    // no dialog in between.
    expect(zeroLater.rollbacks).toHaveLength(1);
    expect(zeroLater.rollbacks[0].body).toEqual({ docName: 'notes', commitSha: VERSION_SHA });
    expect(screen.queryByTestId('timeline-diff-restore-confirm')).toBeNull();

    zeroLater.release();
    await waitFor(() => expect(storeState()).toBe('closed'));
    cleanup();

    const withLater = mockDiffFetch({ holdRollback: true });
    renderPane(3);
    await waitForDiffBody();

    fireEvent.click(restoreButton());
    expect(await screen.findByTestId('timeline-diff-restore-confirm')).toBeTruthy();
    expect(withLater.rollbacks).toHaveLength(0);
  });
});

describe('TimelineDiffPane — dismissing its confirm leaves the document untouched', () => {
  test('Cancel closes the dialog, issues no rollback, and keeps the diff open', async () => {
    const { rollbacks } = mockDiffFetch();

    renderPane(2);
    await waitForDiffBody();
    fireEvent.click(restoreButton());
    await screen.findByTestId('timeline-diff-restore-confirm');

    fireEvent.click(screen.getByTestId('timeline-diff-restore-cancel'));

    await waitFor(() => expect(screen.queryByTestId('timeline-diff-restore-confirm')).toBeNull());
    expect(rollbacks).toHaveLength(0);
    expect(storeState()).toBe('open');
    expect(restoreButton().disabled).toBe(false);
  });

  test('Escape closes the dialog only — the pane keeps its place, and nothing rolls back', async () => {
    const { rollbacks } = mockDiffFetch();

    renderPane(2);
    await waitForDiffBody();
    fireEvent.click(restoreButton());
    await screen.findByTestId('timeline-diff-restore-confirm');

    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByTestId('timeline-diff-restore-confirm')).toBeNull());
    expect(rollbacks).toHaveLength(0);
    // The pane's own Escape-to-close must not have fired underneath the dialog.
    expect(storeState()).toBe('open');
    expect(screen.getByTestId('timeline-diff-pane')).toBeTruthy();
    expect(restoreButton().disabled).toBe(false);
  });
});

describe('TimelineDiffPane — an unresolved restore leaves no half-applied UI', () => {
  test('while the request hangs the pane stays whole, and no second rollback can be issued', async () => {
    const { rollbacks } = mockDiffFetch({ holdRollback: true });

    renderPane(2);
    await waitForDiffBody();
    fireEvent.click(restoreButton());
    const confirm = (await screen.findByTestId(
      'timeline-diff-restore-confirm',
    )) as HTMLButtonElement;

    fireEvent.click(confirm);
    await waitFor(() => expect(rollbacks).toHaveLength(1));

    // The pane has not torn itself down or claimed success on a request that
    // never answered: the diff is still painted, the overlay still claimed.
    expect(screen.getByTestId('timeline-diff-pane')).toBeTruthy();
    expect(screen.getByText('notes')).toBeTruthy();
    expect(storeState()).toBe('open');

    // Both restore affordances are latched while the request is outstanding, so
    // an impatient second click cannot stack a duplicate rollback.
    expect(confirm.disabled).toBe(true);
    expect(restoreButton().disabled).toBe(true);
    fireEvent.click(confirm);
    fireEvent.click(restoreButton());
    expect(rollbacks).toHaveLength(1);
  });

  test('closing the pane mid-flight abandons the wait without a second request', async () => {
    const { rollbacks, release } = mockDiffFetch({ holdRollback: true });

    const { unmount } = renderPane(2);
    await waitForDiffBody();
    fireEvent.click(restoreButton());
    fireEvent.click(await screen.findByTestId('timeline-diff-restore-confirm'));
    await waitFor(() => expect(rollbacks).toHaveLength(1));

    unmount();

    // The pane withdraws from the in-flight request rather than leaving a
    // handler pointed at a disposed tree.
    expect(rollbacks[0].signal?.aborted).toBe(true);
    // A late response cannot resurrect the flow or issue anything further.
    release();
    await waitFor(() => expect(rollbacks).toHaveLength(1));
  });
});
