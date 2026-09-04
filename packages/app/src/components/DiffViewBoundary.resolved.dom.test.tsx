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
    conflictsState = { conflicts: [ENTRY], loading: false, error: null };
    const { rerender } = render(
      <DiffViewBoundary docName="notes/roadmap" provider={makeProvider('# Roadmap\n')} />,
    );
    await waitFor(() => {
      expect(contentFetches.length).toBe(1);
    });

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
    conflictsState = { conflicts: [ENTRY], loading: false, error: null };
    render(<DiffViewBoundary docName="notes/roadmap" provider={makeProvider('# Roadmap\n')} />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /^Accept current/ }).length).toBeGreaterThan(0);
    });
    screen.getAllByRole('button', { name: /^Accept current/ })[0].click();

    const apply = await screen.findByRole('button', { name: 'Apply changes' });
    apply.click();
    await act(async () => {});
    apply.click();
    await act(async () => {});

    expect(resolvePosts).toHaveLength(1);

    releaseResolve?.();
    await act(async () => {});
  });
});
