/**
 * Pins the bounded conflict-entry deferral in `DiffViewBoundary`.
 *
 * An absent conflict entry is ambiguous. For ~100ms after this boundary swaps
 * in it means "the CC1 signal has not caught up"; after a resolution it means
 * "there is no conflict any more". Nothing in the entry distinguishes them, so
 * the wait is bounded rather than guessed.
 *
 * The case that forces a bound rather than a latch: resolving writes the file,
 * the watcher reloads the doc, and this boundary REMOUNTS with no entry to
 * find. "Have we shown a conflict before" is false on a fresh mount, so a latch
 * would leave it waiting forever — which is the hang this exists to prevent.
 *
 * Substrate: jsdom.
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';

vi.doMock('sonner', () => ({
  toast: { error: () => {}, success: () => {}, info: () => {} },
}));
vi.doMock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));
vi.doMock('@/lib/documents-events', () => ({
  subscribeToDocumentsChanged: () => () => {},
}));

let conflictsState: {
  conflicts: { file: string; detectedAt: string }[];
  loading: boolean;
  error: null;
} = { conflicts: [], loading: true, error: null };

vi.doMock('@/hooks/use-conflicts', () => ({
  useConflicts: () => conflictsState,
}));

const { DiffViewBoundary } = await import('./DiffViewBoundary');

/** Comfortably past CONFLICT_ENTRY_GRACE_MS (2s), so the timer has matured. */
const CONFLICT_GRACE_OVERSHOOT_MS = 5_000;

const ENTRY = { file: 'notes/roadmap.md', detectedAt: '2026-08-25T00:00:00.000Z' };

function makeProvider(body: string) {
  const doc = new Y.Doc();
  doc.getText('source').insert(0, body);
  return { document: doc } as unknown as Parameters<typeof DiffViewBoundary>[0]['provider'];
}

const contentFetches: string[] = [];
const resolvePosts: string[] = [];
let releaseResolve: (() => void) | null = null;

beforeEach(() => {
  contentFetches.length = 0;
  resolvePosts.length = 0;
  releaseResolve = null;
  conflictsState = { conflicts: [], loading: true, error: null };
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/sync/resolve-conflict')) {
      resolvePosts.push(url);
      // Held open so a second click lands while the first is still in flight —
      // the window the Apply latch exists for. Server-side this is `git add`
      // plus a commit, so a latch released before it settles is no latch.
      return new Promise<Response>((resolveFetch) => {
        releaseResolve = () =>
          resolveFetch(
            new Response(JSON.stringify({}), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
      });
    }
    if (url.startsWith('/api/sync/conflict-content')) contentFetches.push(url);
    if (url.startsWith('/api/sync/conflict-content')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            file: 'notes/roadmap.md',
            kind: 'both-modified',
            base: '# Roadmap\n\n- Ship date: October 14\n',
            // Diverges from base as well as from theirs — with ours === base, diff3
            // auto-merges and the view renders with no conflict regions at all.
            ours: '# Roadmap\n\n- Ship date: October 21\n',
            theirs: '# Roadmap\n\n- Ship date: Q4\n',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('DiffViewBoundary — conflict resolved while open', () => {
  test('keeps waiting inside the CC1 catch-up window', async () => {
    // lifecycle.status propagates over CRDT faster than the signal that
    // refreshes the conflicts list. An absent entry here means "not yet".
    vi.useFakeTimers();
    conflictsState = { conflicts: [], loading: false, error: null };
    render(<DiffViewBoundary docName="notes/roadmap" provider={makeProvider('# Roadmap\n')} />);

    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    expect(screen.queryByText('This conflict is resolved.')).toBeNull();
    vi.useRealTimers();
  });

  test('reports resolution on a FRESH mount once the entry never arrives', async () => {
    // The hard case: resolving writes the file, the watcher reloads the doc and
    // this boundary REMOUNTS with no entry to find. A latch on "did we show a
    // conflict before" is false here, so only a bounded wait catches it.
    vi.useFakeTimers();
    conflictsState = { conflicts: [], loading: false, error: null };
    render(<DiffViewBoundary docName="notes/roadmap" provider={makeProvider('# Roadmap\n')} />);

    await act(async () => {
      vi.advanceTimersByTime(2500);
    });

    expect(screen.getByText('This conflict is resolved.')).toBeTruthy();
    expect(screen.queryByText(/Loading conflict/)).toBeNull();
    vi.useRealTimers();
  });

  test('reports resolution when a conflict it was showing stops being tracked', async () => {
    conflictsState = { conflicts: [ENTRY], loading: false, error: null };
    const { rerender } = render(
      <DiffViewBoundary docName="notes/roadmap" provider={makeProvider('# Roadmap\n')} />,
    );
    await waitFor(() => {
      expect(screen.queryByText(/Loading conflict/)).toBeNull();
    });

    conflictsState = { conflicts: [], loading: false, error: null };
    rerender(<DiffViewBoundary docName="notes/roadmap" provider={makeProvider('# Roadmap\n')} />);

    await waitFor(
      () => {
        expect(screen.getByText('This conflict is resolved.')).toBeTruthy();
      },
      { timeout: 4000 },
    );
  });

  test('re-fetches when the same file gets a NEW conflict', async () => {
    // A resolved-then-re-detected file keeps its path. Keying the fetch on the
    // path alone leaves the diff frozen on the previous conflict while the rest
    // of the app moves on, so the sides must follow the conflict's identity.
    conflictsState = { conflicts: [ENTRY], loading: false, error: null };
    const { rerender } = render(
      <DiffViewBoundary docName="notes/roadmap" provider={makeProvider('# Roadmap\n')} />,
    );
    await waitFor(() => {
      expect(contentFetches.length).toBe(1);
    });

    // Same file, new detection — what re-arming a conflict produces.
    conflictsState = {
      conflicts: [{ ...ENTRY, detectedAt: '2026-08-25T09:00:00.000Z' }],
      loading: false,
      error: null,
    };
    rerender(<DiffViewBoundary docName="notes/roadmap" provider={makeProvider('# Roadmap\n')} />);

    await waitFor(() => {
      expect(contentFetches.length).toBe(2);
    });
  });

  test('a failed conflicts fetch is not reported as a resolution', async () => {
    // `useConflicts` returns an EMPTY list on a failed fetch. Dropping its
    // `error` made "we could not ask" identical to "nothing is conflicted", so
    // the grace timer matured and told the user the work was done — while the
    // file still carried markers and the editor stayed swapped out. Worse, the
    // panel returns before <ConflictView>, so a mounted view and its whole undo
    // stack are discarded.
    vi.useFakeTimers();
    conflictsState = {
      conflicts: [],
      loading: false,
      error: 'network' as unknown as null,
    };
    render(<DiffViewBoundary docName="notes/roadmap" provider={makeProvider('# Roadmap\n')} />);

    await act(async () => {
      vi.advanceTimersByTime(CONFLICT_GRACE_OVERSHOOT_MS);
    });

    expect(screen.queryByText('This conflict is resolved.')).toBeNull();
    expect(screen.getByText(/Couldn't check whether/)).toBeTruthy();
    vi.useRealTimers();
  });

  test('Apply reaches the endpoint once, through the real boundary wiring', async () => {
    // The latch lives in ConflictView but the promise it awaits is supplied
    // HERE. A previous revision passed `(content) => void handleResolve(content)`,
    // so the latch awaited `undefined` and released on the next microtask
    // rather than after the commit. Testing that through ConflictView alone
    // cannot see it — the wrapper is not in the path. This drives the boundary.
    conflictsState = { conflicts: [ENTRY], loading: false, error: null };
    render(<DiffViewBoundary docName="notes/roadmap" provider={makeProvider('# Roadmap\n')} />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /^Accept current/ }).length).toBeGreaterThan(0);
    });
    screen.getAllByRole('button', { name: /^Accept current/ })[0].click();

    const apply = await screen.findByRole('button', { name: 'Apply changes' });
    apply.click();
    await act(async () => {});
    // Still in flight: the endpoint has not answered.
    apply.click();
    await act(async () => {});

    expect(resolvePosts).toHaveLength(1);

    releaseResolve?.();
    await act(async () => {});
  });
});
