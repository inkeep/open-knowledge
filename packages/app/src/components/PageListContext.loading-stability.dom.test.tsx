/**
 * RTL mount test for the page-list loading-stability contract.
 *
 * Pins the user-visible behavioral contract: once the page list has loaded,
 * a background re-fetch (window focus / visibilitychange / CC1 `files`
 * push) MUST NOT tear the consuming view down to a cold-load skeleton and
 * remount it. `PageListContext.loading` gates a full-view skeleton in
 * consumers (FolderOverview returns one while it is true); the provider's
 * `refetch()` runs on every focus and every external file change, so
 * re-raising `loading` there strobes the entire view on each — a flicker
 * even when the page list is unchanged. The settled verdict the render
 * layer reads (`loading`) must reflect cold-load-only; the fetch lifecycle
 * of background refreshes is invisible to it (last-good `pages` reconcile
 * in place).
 *
 * Drive the background refetch via a real `window` focus event (the
 * provider's own listener). The CC1 documents-events bus is mocked to a
 * no-op so the only background trigger is the explicit focus dispatch —
 * deterministic and hermetic.
 *
 * Invocation: `bun run test:dom` from `packages/app/`.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

interface PageListCachePayload {
  pages: Set<string>;
  folderPaths: Set<string>;
  pagesBySlug: ReadonlyMap<string, string>;
  pagesByBasename: ReadonlyMap<string, string>;
  assetPaths: Set<string>;
  pageIcons: ReadonlyMap<string, string>;
}

const setPageListCacheMock = mock((_payload: PageListCachePayload) => {});

mock.module('@/lib/documents-events', () => ({
  subscribeToDocumentsChanged: () => () => {},
}));

mock.module('@/editor/page-list-cache', () => ({
  buildPageIconsIndex: (pageMeta: ReadonlyMap<string, { icon?: string }>) => {
    const icons = new Map<string, string>();
    for (const [docName, meta] of pageMeta) {
      if (meta.icon) icons.set(docName, meta.icon);
    }
    return icons;
  },
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

import { PageListProvider, usePageList } from './PageListContext';

interface PagesResponseBody {
  pages: {
    docName: string;
    title: string;
    size: number;
    modified: string;
    docExt?: string;
    icon?: string;
  }[];
}
interface DocumentListEntry {
  kind: 'document' | 'asset' | 'folder';
  path?: string;
}
type ResponseResolver = (res: Response) => void;

let pageResolvers: ResponseResolver[] = [];
let docResolvers: ResponseResolver[] = [];
let originalFetch: typeof globalThis.fetch;

function jsonRes(body: unknown) {
  return { ok: true, json: async () => body } as Response;
}

function pagesBody(
  entries: Array<
    | string
    | {
        docName: string;
        title?: string;
        docExt?: string;
        icon?: string;
      }
  >,
): PagesResponseBody {
  return {
    pages: entries.map((entry) => {
      const docName = typeof entry === 'string' ? entry : entry.docName;
      return {
        docName,
        title: typeof entry === 'string' ? entry : (entry.title ?? entry.docName),
        size: 1,
        modified: '2026-01-01T00:00:00.000Z',
        docExt: typeof entry === 'string' ? undefined : entry.docExt,
        icon: typeof entry === 'string' ? undefined : entry.icon,
      };
    }),
  };
}

/** Resolve the most recent in-flight `/api/pages` + `/api/documents` pair. */
async function settleRound(
  docNames: Parameters<typeof pagesBody>[0],
  documents: DocumentListEntry[] = [],
) {
  const pr = pageResolvers.shift();
  const dr = docResolvers.shift();
  if (!pr || !dr) throw new Error('settleRound: no in-flight fetch pair to resolve');
  await act(async () => {
    pr(jsonRes(pagesBody(docNames)));
    dr(jsonRes({ documents }));
    await Promise.resolve();
  });
}

function latestCachePayload() {
  return setPageListCacheMock.mock.calls.at(-1)?.[0] as PageListCachePayload | undefined;
}

beforeEach(() => {
  pageResolvers = [];
  docResolvers = [];
  setPageListCacheMock.mockClear();
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
  globalThis.fetch = originalFetch;
});

function Probe() {
  const { loading, pages } = usePageList();
  if (loading) return <div data-testid="page-list-skeleton" />;
  return <div data-testid="page-list-content">{[...pages].sort().join(',')}</div>;
}

function AddPageProbe() {
  const { addPage, pages } = usePageList();
  return (
    <div>
      <button type="button" onClick={() => addPage('Draft')}>
        Add draft
      </button>
      <span data-testid="page-list-content">{[...pages].sort().join(',')}</span>
    </div>
  );
}

describe('PageListContext loading stability', () => {
  test('PRD-6649: a background refetch (window focus) never re-shows the cold-load skeleton or remounts the view', async () => {
    render(
      <PageListProvider>
        <Probe />
      </PageListProvider>,
    );

    // Cold load: skeleton until the first response lands.
    expect(screen.getByTestId('page-list-skeleton')).not.toBeNull();
    expect(screen.queryByTestId('page-list-content')).toBeNull();

    await settleRound(['A']);
    await waitFor(() => {
      expect(screen.getByTestId('page-list-content')).not.toBeNull();
    });
    expect(screen.queryByTestId('page-list-skeleton')).toBeNull();

    // The exact content node the user is now looking at.
    const coldNode = screen.getByTestId('page-list-content');
    coldNode.setAttribute('data-marker', 'cold');
    const pageFetchesAfterCold = pageResolvers.length; // 0 — cold round drained

    // Background re-trigger: a real window focus. The provider's own
    // listener calls refetch() synchronously (jsdom visibilityState is
    // 'visible'). Pre-fix this called setLoading(true) synchronously in
    // the handler — the skeleton would reappear before any fetch settled.
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });

    // Non-vacuity: the focus actually drove a fresh /api/pages fetch.
    expect(pageResolvers.length).toBe(pageFetchesAfterCold + 1);

    // In-flight window (2nd fetch NOT yet resolved): no skeleton, and the
    // SAME content node — the view did not unmount/remount.
    expect(screen.queryByTestId('page-list-skeleton')).toBeNull();
    const inFlightNode = screen.getByTestId('page-list-content');
    expect(inFlightNode).toBe(coldNode);
    expect(inFlightNode.getAttribute('data-marker')).toBe('cold');

    // Resolve the background round with a CHANGED page list. Content
    // reconciles in place on the same node; still no skeleton.
    await settleRound(['A', 'B']);
    await waitFor(() => {
      expect(screen.getByTestId('page-list-content').textContent).toBe('A,B');
    });
    const afterNode = screen.getByTestId('page-list-content');
    expect(afterNode).toBe(coldNode);
    expect(afterNode.getAttribute('data-marker')).toBe('cold');
    expect(screen.queryByTestId('page-list-skeleton')).toBeNull();
  });

  test('publishes runtime-derived pages, folders, slugs, assets, icons, and optimistic pages to the cache', async () => {
    render(
      <PageListProvider>
        <AddPageProbe />
      </PageListProvider>,
    );

    await settleRound(
      [{ docName: 'Notes/Alpha', icon: '📘', docExt: '.mdx' }],
      [
        { kind: 'folder', path: 'Notes' },
        { kind: 'asset', path: 'images/diagram.png' },
      ],
    );

    await waitFor(() => {
      expect(screen.getByTestId('page-list-content').textContent).toBe('Notes/Alpha');
    });

    let payload = latestCachePayload();
    expect([...(payload?.pages ?? [])]).toEqual(['Notes/Alpha']);
    expect(payload?.pagesBySlug.get('notes-alpha')).toBe('Notes/Alpha');
    expect(payload?.pagesByBasename.get('alpha')).toBe('Notes/Alpha');
    expect([...(payload?.assetPaths ?? [])]).toEqual(['images/diagram.png']);
    expect(payload?.folderPaths.has('Notes')).toBe(true);
    expect(payload?.pageIcons.get('Notes/Alpha')).toBe('📘');

    fireEvent.click(screen.getByRole('button', { name: 'Add draft' }));

    await waitFor(() => {
      expect(screen.getByTestId('page-list-content').textContent).toBe('Draft,Notes/Alpha');
    });

    payload = latestCachePayload();
    expect(payload?.pages.has('Draft')).toBe(true);
    expect(payload?.pagesBySlug.get('draft')).toBe('Draft');
    expect(payload?.pagesByBasename.get('draft')).toBe('Draft');
  });
});
