/**
 * RTL mount test for the page-list push-coalescing contract.
 *
 * Pins the refetch cadence under a CC1 `files` push storm: a bulk agent
 * write can drive `files` pushes at up to ~10x/sec (one per the server's
 * 100 ms per-channel CC1 debounce window). Each push used to refire the full
 * `/api/pages` + `/api/documents` fetch pair immediately; the provider now
 * arms one trailing coalescing timer per quiet window instead, so a burst of
 * pushes produces exactly one refetch. The window is NOT reset by pushes
 * arriving while it is armed — a sustained storm still refreshes at the
 * window cadence rather than starving until the storm ends. The initial
 * mount load is never delayed by the window.
 *
 * Uses the REAL documents-events window bus (unlike the sibling
 * loading-stability test, which mocks it to a no-op) because the timer
 * sits between the bus subscription and the fetch.
 *
 * Invocation: `bun run test:dom` from `packages/app/`.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const setPageListCacheMock = vi.fn((_payload: unknown) => {});

vi.doMock('@/editor/page-list-cache', () => ({
  buildPageIconsIndex: () => new Map<string, string>(),
  buildPagesBySlugIndex: (pages: ReadonlySet<string>, toSlug: (docName: string) => string) => {
    const index = new Map<string, string>();
    for (const docName of pages) {
      const slug = toSlug(docName);
      if (!index.has(slug)) index.set(slug, docName);
    }
    return index;
  },
  buildPagesByBasenameIndex: (pages: ReadonlySet<string>, toSlug: (docName: string) => string) => {
    const index = new Map<string, string>();
    for (const docName of [...pages].sort()) {
      const basename = docName.split('/').pop() ?? docName;
      const slug = toSlug(basename);
      if (!index.has(slug)) index.set(slug, docName);
    }
    return index;
  },
  setPageListCache: setPageListCacheMock,
}));

type ResponseResolver = (res: Response) => void;

let pageResolvers: ResponseResolver[] = [];
let docResolvers: ResponseResolver[] = [];
let originalFetch: typeof globalThis.fetch;

function jsonRes(body: unknown) {
  return { ok: true, json: async () => body } as Response;
}

function pagesBody(docNames: string[]) {
  return {
    pages: docNames.map((docName) => ({
      docName,
      title: docName,
      size: 1,
      modified: '2026-01-01T00:00:00.000Z',
    })),
  };
}

/** Resolve the most recent in-flight `/api/pages` + `/api/documents` pair. */
async function settleRound(docNames: string[]) {
  const pr = pageResolvers.shift();
  const dr = docResolvers.shift();
  if (!pr || !dr) throw new Error('settleRound: no in-flight fetch pair to resolve');
  await act(async () => {
    pr(jsonRes(pagesBody(docNames)));
    dr(jsonRes({ documents: [] }));
    await Promise.resolve();
  });
}

beforeEach(() => {
  pageResolvers = [];
  docResolvers = [];
  setPageListCacheMock.mockClear();
  __resetDocumentListInflightForTests();
  vi.useFakeTimers();
  originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/pages')) {
      return new Promise<Response>((resolve) => {
        pageResolvers.push(resolve);
      });
    }
    if (url.includes('/api/documents')) {
      return new Promise<Response>((resolve) => {
        docResolvers.push(resolve);
      });
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});

function Probe() {
  const { loading, pages } = usePageList();
  if (loading) return <div data-testid="page-list-skeleton" />;
  return <div data-testid="page-list-content">{[...pages].sort().join(',')}</div>;
}

// Import AFTER the mocks above register so transitive dependencies bind to
// the stubs rather than the real modules.
const { PageListProvider, PUSH_REFRESH_COALESCE_MS, usePageList } = await import(
  './PageListContext'
);
const { emitDocumentsChanged } = await import('@/lib/documents-events');
const { __resetDocumentListInflightForTests } = await import('@/lib/documents-fetch');

function emitFilesPush() {
  act(() => {
    emitDocumentsChanged(['files']);
  });
}

describe('PageListContext push coalescing', () => {
  test('initial mount load fires immediately, not through the coalescing window', async () => {
    render(
      <PageListProvider>
        <Probe />
      </PageListProvider>,
    );

    // No timer advance: the cold-load fetch pair is already in flight.
    expect(pageResolvers.length).toBe(1);
    expect(docResolvers.length).toBe(1);

    await settleRound(['A']);
    expect(screen.getByTestId('page-list-content').textContent).toBe('A');
  });

  test('a burst of files pushes coalesces into one trailing refetch', async () => {
    render(
      <PageListProvider>
        <Probe />
      </PageListProvider>,
    );
    await settleRound(['A']);

    for (let i = 0; i < 5; i++) emitFilesPush();

    // Nothing fires inside the window.
    expect(pageResolvers.length).toBe(0);
    act(() => {
      vi.advanceTimersByTime(PUSH_REFRESH_COALESCE_MS - 1);
    });
    expect(pageResolvers.length).toBe(0);

    // The trailing edge flushes exactly one fetch pair for the whole burst.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(pageResolvers.length).toBe(1);
    expect(docResolvers.length).toBe(1);

    await settleRound(['A', 'B']);
    expect(screen.getByTestId('page-list-content').textContent).toBe('A,B');

    // A push after the flush arms a fresh window and fetches again.
    emitFilesPush();
    act(() => {
      vi.advanceTimersByTime(PUSH_REFRESH_COALESCE_MS);
    });
    expect(pageResolvers.length).toBe(1);
  });

  test('pushes arriving mid-window do not extend it (a storm cannot starve the refresh)', async () => {
    render(
      <PageListProvider>
        <Probe />
      </PageListProvider>,
    );
    await settleRound(['A']);

    emitFilesPush();
    act(() => {
      vi.advanceTimersByTime(PUSH_REFRESH_COALESCE_MS / 2);
    });
    emitFilesPush();
    act(() => {
      vi.advanceTimersByTime(PUSH_REFRESH_COALESCE_MS / 2);
    });

    // The flush fired at the ORIGINAL deadline even though the second push
    // landed only half a window ago.
    expect(pageResolvers.length).toBe(1);
  });

  test('non-files channels do not arm the window', async () => {
    render(
      <PageListProvider>
        <Probe />
      </PageListProvider>,
    );
    await settleRound(['A']);

    act(() => {
      emitDocumentsChanged(['backlinks', 'graph']);
    });
    act(() => {
      vi.advanceTimersByTime(PUSH_REFRESH_COALESCE_MS * 2);
    });
    expect(pageResolvers.length).toBe(0);
  });

  test('unmounting while the window is armed cancels the pending refetch', async () => {
    const { unmount } = render(
      <PageListProvider>
        <Probe />
      </PageListProvider>,
    );
    await settleRound(['A']);

    emitFilesPush();
    // Timer armed, nothing in flight yet.
    expect(pageResolvers.length).toBe(0);

    unmount();
    act(() => {
      vi.advanceTimersByTime(PUSH_REFRESH_COALESCE_MS * 2);
    });

    // Cleanup cleared the armed timer and disposed the scheduler, so the
    // torn-down provider never fires a refetch.
    expect(pageResolvers.length).toBe(0);
  });

  test('a focus refetch fires immediately even while a push window is armed', async () => {
    render(
      <PageListProvider>
        <Probe />
      </PageListProvider>,
    );
    await settleRound(['A']);

    emitFilesPush();
    // Push window armed but not yet flushed.
    expect(pageResolvers.length).toBe(0);

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    // Focus refetches immediately through the scheduler — it must NOT be
    // deferred by the 300 ms push window.
    expect(pageResolvers.length).toBe(1);
  });
});
