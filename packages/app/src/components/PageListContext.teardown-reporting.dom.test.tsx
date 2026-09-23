import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { __resetDocumentListInflightForTests } from '@/lib/documents-fetch';

vi.doMock('@/lib/documents-events', () => ({
  subscribeToDocumentsChanged: () => () => {},
}));

vi.doMock('@/editor/page-list-cache', () => ({
  buildPageIconsIndex: () => new Map<string, string>(),
  buildPagesBySlugIndex: () => new Map<string, string>(),
  buildPagesByBasenameIndex: () => new Map<string, string>(),
  setPageListCache: () => {},
}));

const LOAD_PAGES_FAILURE = '[PageListContext] Failed to load pages:';
const LOAD_ASSETS_FAILURE = '[PageListContext] Failed to load referenced assets:';

interface Deferred {
  resolve: (response: Response) => void;
  reject: (cause: unknown) => void;
}

interface DocumentListEntry {
  kind: 'document' | 'asset' | 'folder' | 'file';
  path?: string;
}

let pageRequests: Deferred[] = [];
let documentRequests: Deferred[] = [];
let originalFetch: typeof globalThis.fetch;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

function jsonRes(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function unreadableBodyRes() {
  return {
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError('Unexpected end of JSON input');
    },
  } as Response;
}

function errorRes(status: number, body: unknown) {
  return { ok: false, status, json: async () => body } as Response;
}

function pagesBody(docNames: readonly string[]) {
  return {
    pages: docNames.map((docName) => ({
      docName,
      title: docName,
      size: 1,
      modified: '2026-01-01T00:00:00.000Z',
    })),
  };
}

function loadPagesFailures(): unknown[][] {
  return consoleErrorSpy.mock.calls.filter((call) => call[0] === LOAD_PAGES_FAILURE);
}

function loadAssetsFailures(): unknown[][] {
  return consoleWarnSpy.mock.calls.filter((call) => call[0] === LOAD_ASSETS_FAILURE);
}

async function takeRound(): Promise<{ pages: Deferred; documents: Deferred }> {
  await waitFor(() => {
    expect(pageRequests.length).toBeGreaterThan(0);
    expect(documentRequests.length).toBeGreaterThan(0);
  });
  const pages = pageRequests.shift();
  const documents = documentRequests.shift();
  if (!pages || !documents) throw new Error('takeRound: no in-flight request pair');
  return { pages, documents };
}

async function flush(run: () => void) {
  await act(async () => {
    run();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const SEEDED_DOCUMENTS: DocumentListEntry[] = [
  { kind: 'asset', path: 'images/diagram.png' },
  { kind: 'folder', path: 'archive' },
  { kind: 'file', path: 'notes/todo.txt' },
];

async function seedKnownPaths() {
  const first = await takeRound();
  await flush(() => {
    first.pages.resolve(jsonRes(pagesBody(['Alpha'])));
    first.documents.resolve(jsonRes({ documents: SEEDED_DOCUMENTS }));
  });
  await waitFor(() => {
    expect(screen.getByTestId('assets').textContent).toBe('images/diagram.png');
  });
  expect(screen.getByTestId('folders').textContent).toBe('archive');
  expect(screen.getByTestId('files').textContent).toBe('notes/todo.txt');
}

function expectKnownPathsCleared() {
  expect(screen.getByTestId('assets').textContent).toBe('');
  expect(screen.getByTestId('folders').textContent).toBe('');
  expect(screen.getByTestId('files').textContent).toBe('');
}

function expectKnownPathsIntact() {
  expect(screen.getByTestId('assets').textContent).toBe('images/diagram.png');
  expect(screen.getByTestId('folders').textContent).toBe('archive');
  expect(screen.getByTestId('files').textContent).toBe('notes/todo.txt');
}

async function issueNextRound() {
  await flush(() => {
    window.dispatchEvent(new Event('focus'));
  });
  return takeRound();
}

beforeEach(() => {
  pageRequests = [];
  documentRequests = [];
  __resetDocumentListInflightForTests();
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    const queue = url.includes('/api/pages')
      ? pageRequests
      : url.includes('/api/documents')
        ? documentRequests
        : null;
    if (queue === null) return Promise.reject(new Error(`unexpected fetch: ${url}`));
    return new Promise<Response>((resolve, reject) => {
      queue.push({ resolve, reject });
    });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  consoleErrorSpy.mockRestore();
  consoleWarnSpy.mockRestore();
  __resetDocumentListInflightForTests();
});

const { PageListProvider, usePageList } = await import('./PageListContext');

function Probe() {
  const { loading, error, pages, assetPaths, folderPaths, filePaths } = usePageList();
  return (
    <div>
      <span data-testid="phase">{loading ? 'loading' : 'ready'}</span>
      <span data-testid="error">{error ?? ''}</span>
      <span data-testid="pages">{[...pages].sort().join(',')}</span>
      <span data-testid="assets">{[...assetPaths].sort().join(',')}</span>
      <span data-testid="folders">{[...folderPaths].sort().join(',')}</span>
      <span data-testid="files">{[...filePaths].sort().join(',')}</span>
    </div>
  );
}

function renderProvider() {
  render(
    <PageListProvider>
      <Probe />
    </PageListProvider>,
  );
}

describe('PageListProvider teardown reporting', () => {
  test('a /api/pages failure on a live document reaches the error log and the error state', async () => {
    renderProvider();
    const round = await takeRound();

    await flush(() => {
      round.pages.reject(new TypeError('Failed to fetch'));
      round.documents.resolve(jsonRes({ documents: [] }));
    });

    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toBe('Failed to fetch');
    });
    expect(loadPagesFailures()).toHaveLength(1);
  });

  test('a /api/pages failure that follows a non-bfcache pagehide reaches neither', async () => {
    renderProvider();
    const round = await takeRound();

    await flush(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
      round.pages.reject(new TypeError('Failed to fetch'));
      round.documents.resolve(jsonRes({ documents: [] }));
    });

    await waitFor(() => {
      expect(screen.getByTestId('phase').textContent).toBe('ready');
    });
    expect(screen.getByTestId('error').textContent).toBe('');
    expect(loadPagesFailures()).toEqual([]);
  });

  test('a refresh issued after the pagehide latched is still reported when it fails', async () => {
    renderProvider();
    const first = await takeRound();
    await flush(() => {
      first.pages.resolve(jsonRes(pagesBody(['Alpha'])));
      first.documents.resolve(jsonRes({ documents: [] }));
    });
    await waitFor(() => {
      expect(screen.getByTestId('phase').textContent).toBe('ready');
    });

    await flush(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
      window.dispatchEvent(new Event('focus'));
    });

    const second = await takeRound();
    await flush(() => {
      second.pages.reject(new TypeError('Failed to fetch'));
      second.documents.resolve(jsonRes({ documents: [] }));
    });

    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toBe('Failed to fetch');
    });
    expect(loadPagesFailures()).toHaveLength(1);
  });

  test('a trailing refresh the scheduler queued while the document was live is not reported when teardown kills it', async () => {
    renderProvider();
    const first = await takeRound();

    await flush(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await flush(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
      first.pages.reject(new TypeError('Failed to fetch'));
      first.documents.resolve(jsonRes({ documents: [] }));
    });

    const trailing = await takeRound();
    await flush(() => {
      trailing.pages.reject(new TypeError('Failed to fetch'));
      trailing.documents.resolve(jsonRes({ documents: [] }));
    });

    await waitFor(() => {
      expect(screen.getByTestId('phase').textContent).toBe('ready');
    });
    expect(screen.getByTestId('error').textContent).toBe('');
    expect(loadPagesFailures()).toEqual([]);
  });

  test('a trailing refresh the scheduler queued after the pagehide latched is still reported when it fails', async () => {
    renderProvider();
    const first = await takeRound();

    await flush(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
      window.dispatchEvent(new Event('focus'));
    });

    await flush(() => {
      first.pages.reject(new TypeError('Failed to fetch'));
      first.documents.resolve(jsonRes({ documents: [] }));
    });

    const trailing = await takeRound();
    await flush(() => {
      trailing.pages.reject(new TypeError('Failed to fetch'));
      trailing.documents.resolve(jsonRes({ documents: [] }));
    });

    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toBe('Failed to fetch');
    });
    expect(loadPagesFailures()).toHaveLength(1);
  });

  test('a trailing refresh queued while live is reported when the document comes back before it fails', async () => {
    renderProvider();
    const first = await takeRound();

    await flush(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await flush(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
      first.pages.resolve(jsonRes(pagesBody(['Alpha'])));
      first.documents.resolve(jsonRes({ documents: [] }));
    });

    const trailing = await takeRound();
    await flush(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      trailing.pages.reject(new TypeError('Failed to fetch'));
      trailing.documents.resolve(jsonRes({ documents: [] }));
    });

    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toBe('Failed to fetch');
    });
    expect(loadPagesFailures()).toHaveLength(1);
  });

  test('a refresh issued while live after an earlier latched ask was consumed is not reported when teardown kills it', async () => {
    renderProvider();
    const first = await takeRound();
    await flush(() => {
      first.pages.resolve(jsonRes(pagesBody(['Alpha'])));
      first.documents.resolve(jsonRes({ documents: [] }));
    });
    await waitFor(() => {
      expect(screen.getByTestId('phase').textContent).toBe('ready');
    });

    await flush(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
      window.dispatchEvent(new Event('focus'));
    });

    const latched = await takeRound();
    await flush(() => {
      latched.pages.resolve(jsonRes(pagesBody(['Alpha', 'Beta'])));
      latched.documents.resolve(jsonRes({ documents: [] }));
    });
    await waitFor(() => {
      expect(screen.getByTestId('pages').textContent).toBe('Alpha,Beta');
    });

    await flush(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      window.dispatchEvent(new Event('focus'));
    });

    const revived = await takeRound();
    await flush(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
      revived.pages.reject(new TypeError('Failed to fetch'));
      revived.documents.resolve(jsonRes({ documents: [] }));
    });

    await waitFor(() => {
      expect(screen.getByTestId('phase').textContent).toBe('ready');
    });
    expect(screen.getByTestId('error').textContent).toBe('');
    expect(loadPagesFailures()).toEqual([]);
  });

  test('a throw raised while applying a fetched page list during teardown is still reported', async () => {
    renderProvider();
    const round = await takeRound();

    await flush(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
      round.pages.resolve(jsonRes({ pages: [null] }));
      round.documents.resolve(jsonRes({ documents: [] }));
    });

    await waitFor(() => {
      expect(loadPagesFailures()).toHaveLength(1);
    });
  });

  test('a failed referenced-assets refresh on a live document reports and clears the known paths', async () => {
    renderProvider();
    await seedKnownPaths();

    const second = await issueNextRound();
    await flush(() => {
      second.pages.resolve(jsonRes(pagesBody(['Alpha', 'Beta'])));
      second.documents.reject(new TypeError('Failed to fetch'));
    });

    await waitFor(() => {
      expect(loadAssetsFailures()).toHaveLength(1);
    });
    expectKnownPathsCleared();
  });

  test('an unusable /api/documents payload on a live document reports and clears the known paths', async () => {
    renderProvider();
    await seedKnownPaths();

    const second = await issueNextRound();
    await flush(() => {
      second.pages.resolve(jsonRes(pagesBody(['Alpha', 'Beta'])));
      second.documents.resolve(unreadableBodyRes());
    });

    await waitFor(() => {
      expect(loadAssetsFailures()).toHaveLength(1);
    });
    expectKnownPathsCleared();
  });

  test('an unusable /api/documents payload during teardown preserves the known paths and the provider reports nothing', async () => {
    renderProvider();
    await seedKnownPaths();

    const second = await issueNextRound();
    await flush(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
      second.pages.resolve(jsonRes(pagesBody(['Alpha', 'Beta'])));
      second.documents.resolve(unreadableBodyRes());
    });

    await waitFor(() => {
      expect(screen.getByTestId('pages').textContent).toBe('Alpha,Beta');
    });
    expectKnownPathsIntact();
    expect(loadAssetsFailures()).toEqual([]);
  });

  test('a non-ok /api/pages status on a live document reaches the error log and the error state', async () => {
    renderProvider();
    const round = await takeRound();

    await flush(() => {
      round.pages.resolve(errorRes(503, { title: 'page list unavailable' }));
      round.documents.resolve(jsonRes({ documents: [] }));
    });

    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toBe('page list unavailable');
    });
    expect(loadPagesFailures()).toHaveLength(1);
  });

  test('a non-ok /api/pages status that follows a non-bfcache pagehide reaches neither', async () => {
    renderProvider();
    const round = await takeRound();

    await flush(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
      round.pages.resolve(errorRes(503, { title: 'page list unavailable' }));
      round.documents.resolve(jsonRes({ documents: [] }));
    });

    await waitFor(() => {
      expect(screen.getByTestId('phase').textContent).toBe('ready');
    });
    expect(screen.getByTestId('error').textContent).toBe('');
    expect(loadPagesFailures()).toEqual([]);
  });

  test('an unreadable /api/pages body on a live document reaches the error log and the error state', async () => {
    renderProvider();
    const round = await takeRound();

    await flush(() => {
      round.pages.resolve(unreadableBodyRes());
      round.documents.resolve(jsonRes({ documents: [] }));
    });

    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toBe('Unexpected end of JSON input');
    });
    expect(loadPagesFailures()).toHaveLength(1);
  });

  test('an unreadable /api/pages body that follows a non-bfcache pagehide reaches neither', async () => {
    renderProvider();
    const round = await takeRound();

    await flush(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
      round.pages.resolve(unreadableBodyRes());
      round.documents.resolve(jsonRes({ documents: [] }));
    });

    await waitFor(() => {
      expect(screen.getByTestId('phase').textContent).toBe('ready');
    });
    expect(screen.getByTestId('error').textContent).toBe('');
    expect(loadPagesFailures()).toEqual([]);
  });
});
