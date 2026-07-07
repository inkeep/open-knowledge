/**
 * Show All notice lifecycle + failure interplay:
 *
 *   - error && truncation are INDEPENDENT header state: a child-fetch failure
 *     while a truncation banner is up renders BOTH rows (alert above status)
 *     without contradiction — only the ROOT refresh's HTTP-error path clears
 *     the truncation count.
 *   - banner lifecycle is per-refresh-cycle ("most recent capped listing"):
 *     an UNtruncated child load does not clear another level's banner; the
 *     next root refresh resets banner state from the root response.
 *   - an NDJSON root seed that dies mid-stream surfaces the unreachable-server
 *     alert (no silently-partial tree presented as complete) and the next
 *     refresh recovers fully.
 *   - deep-link drill-down: the active-doc ancestor auto-expand subscriber
 *     composes with the lazy expansion detector — each auto-expanded ancestor
 *     fetches its one level, the chain terminates via the per-cycle cache, and
 *     the target row lands in the model.
 *   - lazy-fetch failure diagnostics carry the folder scope to the console
 *     (the banner shows only the title).
 *
 * Same harness as FileTree.showall-lazy.dom.test.tsx (recording Pierre stub;
 * `mock.module` is safe per-file under the runner's `--isolate`), plus a
 * mutable `activeDocName` so the drill-down test can mount with a deep link
 * active.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { i18n } from '@lingui/core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { emitDocumentsChanged } from '@/lib/documents-events';

i18n.load('en', {});
i18n.activate('en');

function PassThrough({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

const SHOW_ALL_DEPTH1_URL = '/api/documents?showAll=true&dir=&depth=1';

let mergedConfig: unknown = { appearance: { sidebar: {} } };
let showAllResponseFactory: () => Response = () => jsonResponse({ documents: [] });
let responseByUrl = new Map<string, (init?: RequestInit) => Response | Promise<Response>>();
const fetchUrls: string[] = [];
// Mutable so the deep-link test can mount with a doc active; null matches the
// sibling suites' default.
let activeDocNameForTest: string | null = null;

function lazyDirUrl(dir: string): string {
  return `/api/documents?showAll=true&dir=${encodeURIComponent(dir)}&depth=1`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function docEntry(docName: string) {
  return {
    kind: 'document',
    docName,
    docExt: '.md',
    size: 1,
    modified: '2026-06-12T00:00:00.000Z',
  };
}

function folderEntry(path: string, hasChildren: boolean) {
  return {
    kind: 'folder',
    path,
    size: 0,
    modified: '2026-06-12T00:00:00.000Z',
    hasChildren,
  };
}

function makeFetchMock() {
  return mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    fetchUrls.push(url);
    const override = responseByUrl.get(url);
    if (override) return override(init);
    if (url === SHOW_ALL_DEPTH1_URL) return showAllResponseFactory();
    if (url.startsWith('/api/documents')) return jsonResponse({ documents: [docEntry('notes/a')] });
    if (url === '/api/workspace') {
      return jsonResponse({ contentDir: '/tmp/ok', pathSeparator: '/', symlinkResolved: true });
    }
    return jsonResponse({ ok: true });
  });
}

class StubItem {
  expanded = false;
  selected = false;
  constructor(
    readonly path: string,
    private readonly directory: boolean,
    private readonly onChange: () => void = () => {},
  ) {}
  getPath() {
    return this.path;
  }
  isDirectory() {
    return this.directory;
  }
  isExpanded() {
    return this.expanded;
  }
  expand() {
    this.expanded = true;
    this.onChange();
  }
  collapse() {
    this.expanded = false;
    this.onChange();
  }
  isSelected() {
    return this.selected;
  }
  select() {
    this.selected = true;
  }
  deselect() {
    this.selected = false;
  }
  focus() {}
}

class StubModel {
  focusedPath: string | null = null;
  selectedPaths: string[] = [];
  items = new Map<string, StubItem>();
  listeners = new Set<() => void>();
  startRenaming = mock(() => {});
  notify() {
    for (const listener of this.listeners) listener();
  }
  getFocusedPath() {
    return this.focusedPath;
  }
  getFocusedIndex() {
    return -1;
  }
  getItemHeight() {
    return 24;
  }
  getSelectedPaths() {
    return this.selectedPaths;
  }
  getItem(path: string) {
    return this.items.get(path) ?? null;
  }
  resetPaths(paths: string[], opts?: { initialExpandedPaths?: readonly string[] }) {
    this.items.clear();
    for (const path of paths) {
      this.items.set(path, new StubItem(path, path.endsWith('/'), () => this.notify()));
    }
    for (const path of opts?.initialExpandedPaths ?? []) {
      const item = this.items.get(path);
      if (item) item.expanded = true;
    }
    this.notify();
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  onMutation() {
    return () => {};
  }
  isSearchOpen() {
    return false;
  }
  add(path: string) {
    this.items.set(path, new StubItem(path, path.endsWith('/'), () => this.notify()));
  }
  move() {}
  remove() {}
}

const model = new StubModel();

mock.module('sonner', () => ({ toast: { success: mock(() => {}), error: mock(() => {}) } }));
mock.module('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
mock.module('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    activeDocName: activeDocNameForTest,
    activeTarget: null,
    closeTabs: mock(() => {}),
    closeDocument: mock(() => {}),
    closeAndClearDocument: mock(async () => {}),
    closeAndClearForDelete: mock(async () => {}),
    closeAndClearForRename: mock(async () => {}),
    getPoolActiveDocName: () => null,
    poolHas: () => false,
    isNewTabActive: false,
    openTarget: mock(() => {}),
    prewarm: () => {},
    remapTabsForRename: mock(() => {}),
  }),
}));
mock.module('@/components/PageListContext', () => ({
  usePageList: () => ({ addPage: mock(() => {}) }),
}));
mock.module('./ui/sidebar', () => ({
  useSidebar: () => ({ notifySidebarFileSelected: mock(() => {}) }),
}));
mock.module('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    okignoreBinding: null,
    projectLocalBinding: null,
    merged: mergedConfig,
  }),
}));
mock.module('./handoff/useInstalledAgents', () => ({ useInstalledAgents: () => ({ states: {} }) }));
mock.module('./handoff/useHandoffDispatch', () => ({
  buildFolderHandoffInput: () => null,
  buildHandoffInput: () => null,
  useHandoffDispatch: () => ({ dispatch: mock(async () => ({ ok: true as const })) }),
}));
mock.module('./handoff/OpenInAgentContextSubmenu', () => ({
  OpenInAgentContextSubmenu: () => null,
}));
mock.module('./sidebar-hover-prewarm', () => ({
  cancelHoverPrewarm: () => {},
  scheduleHoverPrewarm: () => {},
}));
mock.module('@/components/ui/button', () => ({
  Button: ({ children, ...props }: { children?: ReactNode; [k: string]: unknown }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));
mock.module('@/components/ui/dialog', () => ({ Dialog: PassThrough }));
mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: PassThrough,
  DropdownMenuCheckboxItem: PassThrough,
  DropdownMenuContent: PassThrough,
  DropdownMenuItem: PassThrough,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuSub: PassThrough,
  DropdownMenuSubContent: PassThrough,
  DropdownMenuSubTrigger: PassThrough,
  DropdownMenuTrigger: PassThrough,
}));
mock.module('@/components/ui/skeleton', () => ({
  Skeleton: ({ className }: { className?: string }) => <span className={className} />,
}));
mock.module('@/components/DeleteConfirmationDialog', () => ({
  DeleteConfirmationDialog: () => null,
}));
mock.module('@/components/NewItemDialog', () => ({ NewItemDialog: () => null }));
mock.module('@/components/TrashFailureModal', () => ({
  TrashFailureModal: () => null,
  coerceTrashFailureReason: (reason: string) => reason,
}));
mock.module('@/components/use-selection-mirror', () => ({
  asDirectoryHandle: (item: StubItem | null) => (item?.isDirectory() ? item : null),
  useSelectionMirror: () => {},
}));
mock.module('@pierre/trees', () => ({
  FILE_TREE_TAG_NAME: 'ok-file-tree',
  themeToTreeStyles: () => ({}),
}));
mock.module('@pierre/trees/react', () => ({
  useFileTree: () => ({ model }),
  FileTree: ({ header }: { header?: ReactNode }) => (
    <div data-testid="fake-pierre-tree" role="tree">
      {header}
    </div>
  ),
}));

const { FileTree } = await import('./FileTree');

describe('FileTree showAll notice lifecycle', () => {
  let consoleWarnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mergedConfig = { appearance: { sidebar: {} } };
    showAllResponseFactory = () =>
      jsonResponse({
        documents: [folderEntry('capped', true), folderEntry('uncapped', true), docEntry('README')],
        truncated: false,
      });
    responseByUrl = new Map();
    fetchUrls.length = 0;
    activeDocNameForTest = null;
    model.items.clear();
    model.listeners.clear();
    model.focusedPath = null;
    model.selectedPaths = [];
    globalThis.fetch = makeFetchMock() as unknown as typeof fetch;
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleWarnSpy.mockRestore();
  });

  async function renderSeededTree() {
    render(<FileTree />);
    await waitFor(() => expect(model.items.size).toBe(3));
  }

  async function expandCappedFolderToTruncation() {
    responseByUrl.set(lazyDirUrl('capped'), () =>
      jsonResponse({
        documents: [docEntry('capped/one'), docEntry('capped/two')],
        truncated: true,
      }),
    );
    model.getItem('capped/')?.expand();
    await waitFor(() => {
      expect(screen.getByRole('status').textContent ?? '').toContain('Showing the first 2 items');
    });
  }

  test('a child-fetch error while a truncation banner is up renders BOTH rows coherently (QA-003)', async () => {
    await renderSeededTree();
    await expandCappedFolderToTruncation();

    // A DIFFERENT folder's level fails: error state raises the alert without
    // touching the truncation count — only the root refresh path clears it.
    responseByUrl.set(lazyDirUrl('uncapped'), () =>
      jsonResponse({ title: 'Folder walk failed' }, 500),
    );
    model.getItem('uncapped/')?.expand();

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent ?? '').toContain('Folder walk failed');
    });
    // Both notices are up simultaneously and stay individually truthful.
    const alert = screen.getByRole('alert');
    const status = screen.getByRole('status');
    expect(status.textContent ?? '').toContain('Showing the first 2 items');
    // The header renders the error row above the truncation row — a stable
    // reading order rather than an arbitrary stack.
    expect(alert.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Both carry the contained-row treatment; neither crashed the tree.
    expect(alert.className).toContain('rounded-md');
    expect(status.className).toContain('rounded-md');
    expect(model.items.has('capped/one.md')).toBe(true);

    // The failure was console-traceable to its folder (the banner shows only
    // the title — the log is the scope carrier).
    const scopedWarn = consoleWarnSpy.mock.calls.find(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('lazy folder children http error') &&
        call[1] === 'uncapped/',
    );
    expect(scopedWarn).toBeDefined();
  });

  test('an untruncated child load does NOT clear another level’s banner (QA-023 per-cycle semantics)', async () => {
    await renderSeededTree();
    await expandCappedFolderToTruncation();

    responseByUrl.set(lazyDirUrl('uncapped'), () =>
      jsonResponse({ documents: [docEntry('uncapped/fine')], truncated: false }),
    );
    model.getItem('uncapped/')?.expand();
    await waitFor(() => expect(model.items.has('uncapped/fine.md')).toBe(true));

    // The banner still describes the most recent CAPPED listing — the
    // untruncated load neither clears it nor rewrites its count.
    expect(screen.getByRole('status').textContent ?? '').toContain('Showing the first 2 items');
  });

  test('the next root refresh resets the banner from the root response (QA-023 lifecycle)', async () => {
    await renderSeededTree();
    await expandCappedFolderToTruncation();

    // Collapse the capped folder so the refresh's expanded-dir revalidation
    // does not re-fetch (and re-truncate) it; the root response is the only
    // input to the new cycle's banner state.
    model.getItem('capped/')?.collapse();
    emitDocumentsChanged(['files']);

    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    // The tree itself survived the refresh.
    expect(model.items.has('capped/')).toBe(true);
  });

  test('a network-rejected child fetch logs the folder-scoped diagnostic (QA-022)', async () => {
    await renderSeededTree();
    responseByUrl.set(lazyDirUrl('uncapped'), () => {
      throw new TypeError('Failed to fetch');
    });
    model.getItem('uncapped/')?.expand();

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent ?? '').toContain('Could not reach server');
    });
    const networkWarn = consoleWarnSpy.mock.calls.find(
      (call) =>
        typeof call[0] === 'string' && call[0].includes('lazy folder children fetch failed'),
    );
    expect(networkWarn).toBeDefined();
  });
});

describe('FileTree showAll interrupted NDJSON seed', () => {
  let consoleWarnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mergedConfig = { appearance: { sidebar: {} } };
    showAllResponseFactory = () => jsonResponse({ documents: [] });
    responseByUrl = new Map();
    fetchUrls.length = 0;
    activeDocNameForTest = null;
    model.items.clear();
    model.listeners.clear();
    model.focusedPath = null;
    model.selectedPaths = [];
    globalThis.fetch = makeFetchMock() as unknown as typeof fetch;
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleWarnSpy.mockRestore();
  });

  /** An NDJSON Response whose stream flushes one entry line then dies. */
  function dyingSeedResponse(): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`${JSON.stringify(folderEntry('ghost', true))}\n`));
        controller.error(new TypeError('connection reset'));
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
    });
  }

  test('a FIRST seed stream dying mid-listing shows an honest error state, then recovers (QA-025)', async () => {
    let seedRequests = 0;
    showAllResponseFactory = () => {
      seedRequests += 1;
      if (seedRequests === 1) return dyingSeedResponse();
      return jsonResponse({
        documents: [folderEntry('team', true), docEntry('README')],
        truncated: false,
      });
    };
    render(<FileTree />);

    // With no prior documents the death lands on the empty-tree error state —
    // an honest "Could not reach server", never the flushed prefix presented
    // as a complete listing (no tree, no ghost row, no truncation banner).
    await screen.findByText('Could not reach server');
    expect(model.items.has('ghost/')).toBe(false);
    expect(screen.queryByTestId('fake-pierre-tree')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();

    // Server comes back; the next refresh cycle restores a correct tree and
    // clears the error.
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(model.items.has('team/')).toBe(true));
    expect(model.items.has('README.md')).toBe(true);
    expect(model.items.has('ghost/')).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Could not reach server')).toBeNull();
  });

  test('a REFRESH stream dying mid-listing raises the header alert over the intact tree, then recovers (QA-025)', async () => {
    let seedRequests = 0;
    showAllResponseFactory = () => {
      seedRequests += 1;
      if (seedRequests === 2) return dyingSeedResponse();
      return jsonResponse({
        documents: [folderEntry('team', true), docEntry('README')],
        truncated: false,
      });
    };
    render(<FileTree />);
    await waitFor(() => expect(model.items.has('team/')).toBe(true));

    // Mid-session refresh dies: the previously-loaded tree stays visible and
    // the failure surfaces as the header alert — degraded, not blanked, and
    // the dead stream's partial prefix never replaces the good listing.
    window.dispatchEvent(new Event('focus'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').toContain('Could not reach server');
    expect(model.items.has('team/')).toBe(true);
    expect(model.items.has('README.md')).toBe(true);
    expect(model.items.has('ghost/')).toBe(false);

    // Connectivity returns: the next cycle clears the alert and the tree is
    // fully restored.
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(model.items.has('team/')).toBe(true);
    expect(model.items.has('ghost/')).toBe(false);
  });
});

describe('FileTree showAll deep-link progressive drill-down', () => {
  let consoleWarnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mergedConfig = { appearance: { sidebar: {} } };
    showAllResponseFactory = () =>
      jsonResponse({ documents: [folderEntry('a', true)], truncated: false });
    responseByUrl = new Map();
    fetchUrls.length = 0;
    activeDocNameForTest = null;
    model.items.clear();
    model.listeners.clear();
    model.focusedPath = null;
    model.selectedPaths = [];
    globalThis.fetch = makeFetchMock() as unknown as typeof fetch;
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleWarnSpy.mockRestore();
  });

  test('opening a doc 3 levels deep auto-expands and lazily loads each ancestor level exactly once (QA-026)', async () => {
    // Deep link active from mount: the ancestor auto-expand subscriber
    // composes with the expansion detector — expand → one depth-1 fetch →
    // splice → next ancestor appears → expand → … until the doc's level.
    activeDocNameForTest = 'a/b/c/doc';
    responseByUrl.set(lazyDirUrl('a'), () =>
      jsonResponse({ documents: [folderEntry('a/b', true)], truncated: false }),
    );
    responseByUrl.set(lazyDirUrl('a/b'), () =>
      jsonResponse({ documents: [folderEntry('a/b/c', true)], truncated: false }),
    );
    responseByUrl.set(lazyDirUrl('a/b/c'), () =>
      jsonResponse({ documents: [docEntry('a/b/c/doc')], truncated: false }),
    );
    render(<FileTree />);

    // The chain walks itself open level by level until the target row exists.
    await waitFor(() => expect(model.items.has('a/b/c/doc.md')).toBe(true));
    expect(model.getItem('a/')?.isExpanded()).toBe(true);
    expect(model.getItem('a/b/')?.isExpanded()).toBe(true);
    expect(model.getItem('a/b/c/')?.isExpanded()).toBe(true);

    // Exactly one depth-1 fetch per ancestor level — no refetch storm, no
    // recursive-walk fallback.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchUrls.filter((url) => url === lazyDirUrl('a'))).toHaveLength(1);
    expect(fetchUrls.filter((url) => url === lazyDirUrl('a/b'))).toHaveLength(1);
    expect(fetchUrls.filter((url) => url === lazyDirUrl('a/b/c'))).toHaveLength(1);
    expect(fetchUrls.filter((u) => u.includes('showAll=true') && !u.includes('depth=1'))).toEqual(
      [],
    );

    // The chain TERMINATED: no further document fetches after the target
    // level loaded (the per-cycle cache absorbs the post-splice re-expands).
    const settledCount = fetchUrls.filter((url) => url.startsWith('/api/documents')).length;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchUrls.filter((url) => url.startsWith('/api/documents')).length).toBe(settledCount);
  });
});
