/**
 * Lazy Show All listing (client half): root seed + per-folder
 * expansion.
 *
 * The sidebar fetches ONE level (`?showAll=true&dir=&depth=1`) instead of the
 * full recursive walk: the depth-1 response seeds the Pierre model with
 * exactly the returned level-1 paths (folders as directory items whatever
 * their `hasChildren` value, documents as files), and the response's
 * `truncated` flag still drives the truncation notice. Expanding a folder
 * fetches its children on demand (`?dir=<folder>&depth=1`) and splices them
 * into the tree without losing the expansion state of other folders.
 *
 * Same harness as FileTree.showall-truncation.dom.test.tsx: a live-browser
 * pass needs a dev-server socket the test sandbox denies, so this DOM suite is
 * the durable substitute. `@pierre/trees/react` is mocked with a recording
 * model — the paths handed to it are the contract the sidebar owes Pierre.
 * The stub mirrors the two Pierre behaviors the lazy client leans on:
 * `subscribe` fires on every state change (expand/collapse included), and
 * `resetPaths` re-applies `initialExpandedPaths`.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { i18n } from '@lingui/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MouseEventHandler, ReactNode } from 'react';
import { emitDocumentsChanged } from '@/lib/documents-events';

// Deterministic `Intl.NumberFormat` output for the truncation-notice smoke
// test, matching the production `src/lib/i18n.ts` activation.
i18n.load('en', {});
i18n.activate('en');

function PassThrough({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

const SHOW_ALL_DEPTH1_URL = '/api/documents?showAll=true&dir=&depth=1';

// --- mutable per-test state ---
// The sidebar always issues the lazy depth-1 disk-walk listing; these tests
// exercise that default path. Config carries the sidebar visibility toggles
// (`showHiddenFiles`, `showOnlyMarkdownFiles`).
let mergedConfig: unknown = { appearance: { sidebar: {} } };
// Factory for the depth-1 response so the NDJSON test can stream instead of
// returning buffered JSON.
let showAllResponseFactory: () => Response = () => jsonResponse({ documents: [] });
// Per-URL overrides consulted before the defaults — the lazy-expansion tests
// register `?dir=<folder>&depth=1` child responses here. Overrides receive
// the RequestInit so a test can honor `init.signal` (the shared mock ignores
// aborts on purpose — late resolutions exercise the generation guard).
let responseByUrl = new Map<string, (init?: RequestInit) => Response | Promise<Response>>();
const fetchUrls: string[] = [];

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

// Non-markdown leaf as the showAll disk walk ships it: every non-md file is
// `kind:'asset'` with an empty `referencedBy` (the walk never computes real
// references).
function assetEntry(path: string) {
  return {
    kind: 'asset',
    path,
    assetExt: path.split('.').pop() ?? 'file',
    mediaKind: null,
    size: 1,
    modified: '2026-06-12T00:00:00.000Z',
    referencedBy: [],
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
    // Any other endpoint the mount touches (delete/rename cleanup, etc.).
    return jsonResponse({ ok: true });
  });
}

// --- module mocks (mirrors the FileTree.showall-truncation dom-test set so
// the component mounts; the Pierre stub records the paths it is handed). ---

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
  // Mirrors Pierre: a reset rebuilds the item set, re-applies
  // `initialExpandedPaths`, and emits one state-change to subscribers.
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
const openTargetMock = mock(() => {});

mock.module('sonner', () => ({ toast: { success: mock(() => {}), error: mock(() => {}) } }));
mock.module('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
mock.module('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    activeDocName: null,
    activeTarget: null,
    closeTabs: mock(() => {}),
    closeDocument: mock(() => {}),
    closeAndClearDocument: mock(async () => {}),
    closeAndClearForDelete: mock(async () => {}),
    closeAndClearForRename: mock(async () => {}),
    getPoolActiveDocName: () => null,
    poolHas: () => false,
    isNewTabActive: false,
    openTarget: openTargetMock,
    prewarm: () => {},
    remapTabsForRename: mock(() => {}),
  }),
}));
mock.module('@/components/PageListContext', () => ({
  usePageList: () => ({ addPage: mock(() => {}), pages: new Set<string>() }),
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
  FileTree: ({
    header,
    onClickCapture,
  }: {
    header?: ReactNode;
    onClickCapture?: MouseEventHandler<HTMLDivElement>;
  }) => {
    return (
      <div data-testid="fake-pierre-tree" role="tree" onClickCapture={onClickCapture}>
        {header}
        {[...model.items.values()].map((item) => (
          <div
            key={item.path}
            role="treeitem"
            data-item-path={item.path}
            data-item-type={item.isDirectory() ? 'folder' : 'file'}
            aria-selected={model.selectedPaths.includes(item.path) ? 'true' : 'false'}
            tabIndex={-1}
          >
            {item.path}
          </div>
        ))}
      </div>
    );
  },
}));

const { FileTree } = await import('./FileTree');
// Real relaunch-store module (NOT mocked) — the same singleton `FileTree`'s
// `useRelaunchInFlight` reads, so firing the captured bridge callbacks flips the
// store the rendered component observes.
const { attachRelaunchStateSubscribers, resetRelaunchStoreForTest } = await import(
  '@/lib/relaunch-store'
);

describe('FileTree showAll lazy root seed', () => {
  let consoleWarnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mergedConfig = { appearance: { sidebar: {} } };
    showAllResponseFactory = () => jsonResponse({ documents: [] });
    responseByUrl = new Map();
    fetchUrls.length = 0;
    model.items.clear();
    model.listeners.clear();
    model.focusedPath = null;
    model.selectedPaths = [];
    openTargetMock.mockClear();
    window.location.hash = '';
    globalThis.fetch = makeFetchMock() as unknown as typeof fetch;
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleWarnSpy.mockRestore();
  });

  test('Show All ON seeds the tree from one depth-1 root fetch, never the recursive walk (QA-001)', async () => {
    showAllResponseFactory = () =>
      jsonResponse({
        documents: [folderEntry('team', true), folderEntry('empty', false), docEntry('README')],
        truncated: false,
      });
    render(<FileTree />);

    await screen.findByTestId('fake-pierre-tree');
    await waitFor(() => expect(fetchUrls).toContain(SHOW_ALL_DEPTH1_URL));
    // The model received exactly the level-1 paths — folders as directories
    // (trailing slash), the document with its extension. Exact equality pins
    // "level-1 entries only": nothing deeper is seeded. waitFor: the model is
    // populated by the reset effect, which flushes after the fetch resolves —
    // asserting synchronously races it on slow runners.
    await waitFor(() =>
      expect([...model.items.keys()].sort()).toEqual(['README.md', 'empty/', 'team/']),
    );
    // No request may fall back to the full recursive walk (showAll without
    // the depth=1 level bound). Checked after the model settles so the
    // negative assertion covers the whole seed cycle, not a partial prefix.
    expect(fetchUrls.filter((u) => u.includes('showAll=true') && !u.includes('depth=1'))).toEqual(
      [],
    );
  });

  test('unresolved config still seeds the disk-walk root — it is the only listing mode', async () => {
    // No merged config yet (the cold-start window before the project-local
    // binding resolves). The disk-walk listing is the only mode, so the very
    // first fetch must already be the depth-1 showAll root walk, not the bare
    // index — there is no flash of a filtered listing followed by a switch.
    mergedConfig = null;
    showAllResponseFactory = () =>
      jsonResponse({
        documents: [folderEntry('team', true), docEntry('README')],
        truncated: false,
      });
    render(<FileTree />);

    await screen.findByTestId('fake-pierre-tree');
    await waitFor(() => expect(fetchUrls).toContain(SHOW_ALL_DEPTH1_URL));
    // The bare index URL is never requested — the cold-start fetch went
    // straight to the showAll walk.
    expect(fetchUrls).not.toContain('/api/documents');
    await waitFor(() => expect([...model.items.keys()].sort()).toEqual(['README.md', 'team/']));
  });

  test('Show hidden files alone gates dot-segment entries in the disk-walk listing', async () => {
    // The client dot-segment drop is keyed solely on showHiddenFiles (the
    // Show all files toggle is gone), so this toggle alone decides whether
    // dot-segment entries the disk walk ships are shown. OFF: a root-level
    // dotfile is dropped client-side while its non-dot sibling stays;
    // flipping ON re-fetches and reveals it.
    mergedConfig = { appearance: { sidebar: { showHiddenFiles: false } } };
    showAllResponseFactory = () =>
      jsonResponse({
        documents: [docEntry('README'), docEntry('.secret-note')],
        truncated: false,
      });
    const view = render(<FileTree />);

    await screen.findByTestId('fake-pierre-tree');
    await waitFor(() => expect(model.items.has('README.md')).toBe(true));
    expect(model.items.has('.secret-note.md')).toBe(false);

    mergedConfig = { appearance: { sidebar: { showHiddenFiles: true } } };
    view.rerender(<FileTree />);

    await waitFor(() => expect(model.items.has('.secret-note.md')).toBe(true));
    expect(model.items.has('README.md')).toBe(true);
  });

  test('seeded folders are directory items for both hasChildren values; documents are files', async () => {
    showAllResponseFactory = () =>
      jsonResponse({
        documents: [folderEntry('team', true), folderEntry('empty', false), docEntry('README')],
        truncated: false,
      });
    render(<FileTree />);

    await screen.findByTestId('fake-pierre-tree');
    await waitFor(() => expect(model.items.size).toBe(3));
    // A directory item is the expand affordance Pierre renders. A folder the
    // server marked childless still classifies as a folder (it expands to
    // empty, matching how the recursive walk rendered empty folders) — it must
    // not be dropped or demoted to a file row.
    expect(model.getItem('team/')?.isDirectory()).toBe(true);
    expect(model.getItem('empty/')?.isDirectory()).toBe(true);
    expect(model.getItem('README.md')?.isDirectory()).toBe(false);
  });

  test('first click on non-document file rows opens the asset tab', async () => {
    showAllResponseFactory = () =>
      jsonResponse({
        documents: [assetEntry('LICENSE'), assetEntry('package.json')],
        truncated: false,
      });
    const view = render(<FileTree />);

    await waitFor(() => expect(model.items.has('package.json')).toBe(true));
    view.rerender(<FileTree />);
    for (const path of ['LICENSE', 'package.json']) {
      const row = screen.getByRole('treeitem', { name: path });
      fireEvent.click(row);

      await waitFor(() =>
        expect(openTargetMock).toHaveBeenCalledWith(
          {
            kind: 'asset',
            target: path,
            assetPath: path,
            mediaKind: null,
          },
          { tabBehavior: 'replace-active' },
        ),
      );
      expect(window.location.hash).toBe(`#/__asset__/${path}`);
      openTargetMock.mockClear();
      window.location.hash = '';
    }
  });

  test('first click from one document row to README opens README', async () => {
    showAllResponseFactory = () =>
      jsonResponse({
        documents: [docEntry('foo'), docEntry('README')],
        truncated: false,
      });
    const view = render(<FileTree />);

    await waitFor(() => expect(model.items.has('README.md')).toBe(true));
    model.selectedPaths = ['foo.md'];
    view.rerender(<FileTree />);
    const row = screen.getByRole('treeitem', { name: 'README.md' });
    fireEvent.click(row);

    await waitFor(() =>
      expect(openTargetMock).toHaveBeenCalledWith(
        {
          kind: 'doc',
          target: 'README',
          docName: 'README',
        },
        { tabBehavior: 'replace-active' },
      ),
    );
    expect(window.location.hash).toBe('#/README');
  });

  test('first click from a document row to a folder opens the folder', async () => {
    showAllResponseFactory = () =>
      jsonResponse({
        documents: [docEntry('foo'), folderEntry('docs', true), docEntry('docs/nested')],
        truncated: false,
      });
    const view = render(<FileTree />);

    await waitFor(() => expect(model.items.has('docs/')).toBe(true));
    model.selectedPaths = ['foo.md'];
    view.rerender(<FileTree />);
    expect(model.getItem('docs/')?.isExpanded()).toBe(false);
    const row = screen.getByRole('treeitem', { name: 'docs/' });
    fireEvent.click(row);

    await waitFor(() =>
      expect(openTargetMock).toHaveBeenCalledWith(
        {
          kind: 'folder',
          target: 'docs',
          folderPath: 'docs',
        },
        { tabBehavior: 'replace-active' },
      ),
    );
    expect(window.location.hash).toBe('#/docs/');
    expect(model.getItem('docs/')?.isExpanded()).toBe(true);
  });

  test('a truncated depth-1 level still drives the truncation notice (QA-002 wiring)', async () => {
    showAllResponseFactory = () =>
      jsonResponse({
        documents: [docEntry('a'), docEntry('b'), docEntry('c')],
        truncated: true,
      });
    render(<FileTree />);

    // waitFor (not findByRole): the loading skeleton mounts its own
    // role=status, so a poll landing mid-load just retries.
    await waitFor(() => {
      expect(screen.getByRole('status').textContent ?? '').toContain('Showing the first 3 items');
    });
  });

  test('seeds from a streamed NDJSON depth-1 response (entries + complete line)', async () => {
    const lines = [
      JSON.stringify(folderEntry('team', true)),
      JSON.stringify(docEntry('README')),
      JSON.stringify({ type: 'complete', truncated: true, count: 2 }),
    ].join('\n');
    showAllResponseFactory = () =>
      new Response(`${lines}\n`, {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      });
    render(<FileTree />);

    await waitFor(() => expect(model.items.size).toBe(2));
    expect([...model.items.keys()].sort()).toEqual(['README.md', 'team/']);
    // The streamed complete-line truncation verdict reaches the notice too.
    await waitFor(() => {
      expect(screen.getByRole('status').textContent ?? '').toContain('Showing the first 2 items');
    });
  });

  test('paints the first NDJSON chunk before the stream completes (incremental seed)', async () => {
    // Gate the second chunk so the stream stays open after the first. This pins
    // that rows render as they arrive — not only once the walk finishes.
    let releaseRest: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseRest = resolve;
    });
    const encoder = new TextEncoder();
    showAllResponseFactory = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode(`${JSON.stringify(folderEntry('team', true))}\n`));
            await gate;
            controller.enqueue(
              encoder.encode(
                `${JSON.stringify(docEntry('README'))}\n${JSON.stringify({
                  type: 'complete',
                  truncated: false,
                  count: 2,
                })}\n`,
              ),
            );
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
      );
    render(<FileTree />);

    // First chunk paints while the stream is still open: the folder row is
    // present and README (not yet streamed) is absent — proving the root level
    // is not withheld until completion.
    await waitFor(() => expect([...model.items.keys()]).toEqual(['team/']));

    // The loading skeleton (its own role=status) clears on the first batch, not
    // at completion; no truncation notice exists yet, so status is now absent.
    expect(screen.queryByRole('status')).toBeNull();

    releaseRest();

    // Completion reconciles the full level.
    await waitFor(() => expect([...model.items.keys()].sort()).toEqual(['README.md', 'team/']));
  });

  test('a first chunk of only hidden entries does not clear the skeleton (no empty-state flash)', async () => {
    // The server walk emits hidden dirs (`.github/`, …) in arbitrary readdir
    // order; the client filters them. A first chunk that filters down to zero
    // visible rows must NOT flip loading false — otherwise the tree renders the
    // "No files yet" empty state (loading=false + documents=[]) on a non-empty
    // KB until the visible rows stream in. Gate the visible chunk to hold the
    // stream open on the hidden-only first chunk.
    let releaseVisible: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseVisible = resolve;
    });
    const encoder = new TextEncoder();
    showAllResponseFactory = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode(`${JSON.stringify(folderEntry('.github', true))}\n`));
            await gate;
            controller.enqueue(
              encoder.encode(
                `${JSON.stringify(folderEntry('docs', true))}\n${JSON.stringify({
                  type: 'complete',
                  truncated: false,
                  count: 2,
                })}\n`,
              ),
            );
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
      );
    render(<FileTree />);

    // Wait until the stream is in flight, then let the hidden-only first chunk
    // be consumed. The skeleton (role=status) must still be up and the
    // empty-state CTA absent — no flash.
    await waitFor(() => expect(fetchUrls).toContain(SHOW_ALL_DEPTH1_URL));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByText(/No files yet|Create your first/i)).toBeNull();
    expect(screen.queryByRole('status')).not.toBeNull();
    expect(model.items.size).toBe(0);

    // The visible chunk paints and clears the skeleton.
    releaseVisible();
    await waitFor(() => expect([...model.items.keys()]).toEqual(['docs/']));
  });

  test('a server-emitted NDJSON error line surfaces its problem title, not the connectivity copy', async () => {
    // The error control line arrived over a live connection — the server WAS
    // reached, so "Could not reach server" would be untruthful. The transport-
    // death case (reader rejection) keeps the connectivity copy; see the
    // interrupted-seed suite.
    const lines = [
      JSON.stringify(folderEntry('team', true)),
      JSON.stringify({ type: 'error', problem: { title: 'Folder walk failed mid-stream' } }),
    ].join('\n');
    showAllResponseFactory = () =>
      new Response(`${lines}\n`, {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      });
    render(<FileTree />);

    await screen.findByText('Folder walk failed mid-stream');
    expect(screen.queryByText('Could not reach server')).toBeNull();
  });
});

describe('FileTree showAll lazy folder expansion', () => {
  let consoleWarnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mergedConfig = { appearance: { sidebar: {} } };
    showAllResponseFactory = () =>
      jsonResponse({
        documents: [folderEntry('team', true), folderEntry('empty', false), docEntry('README')],
        truncated: false,
      });
    responseByUrl = new Map();
    fetchUrls.length = 0;
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

  test('expanding an unloaded folder fetches one level and splices the children in (QA-004)', async () => {
    responseByUrl.set(lazyDirUrl('team'), () =>
      jsonResponse({
        documents: [folderEntry('team/sub', true), docEntry('team/notes')],
        truncated: false,
      }),
    );
    await renderSeededTree();

    model.getItem('team/')?.expand();

    await waitFor(() =>
      expect([...model.items.keys()].sort()).toEqual([
        'README.md',
        'empty/',
        'team/',
        'team/notes.md',
        'team/sub/',
      ]),
    );
    expect(fetchUrls.filter((url) => url === lazyDirUrl('team'))).toHaveLength(1);
    // The splice rebuild must not collapse the folder the user just opened.
    expect(model.getItem('team/')?.isExpanded()).toBe(true);
  });

  test('collapse and re-expand serves the already-loaded children without refetching (QA-005)', async () => {
    responseByUrl.set(lazyDirUrl('team'), () =>
      jsonResponse({ documents: [docEntry('team/notes')], truncated: false }),
    );
    await renderSeededTree();

    model.getItem('team/')?.expand();
    await waitFor(() => expect(model.items.has('team/notes.md')).toBe(true));

    model.getItem('team/')?.collapse();
    model.getItem('team/')?.expand();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchUrls.filter((url) => url === lazyDirUrl('team'))).toHaveLength(1);
    // The cached children are still in the tree for the re-opened folder.
    expect(model.items.has('team/notes.md')).toBe(true);
  });

  test('re-expanding a folder while its fetch is still in flight does not start a duplicate', async () => {
    let releaseChildren: () => void = () => {};
    responseByUrl.set(
      lazyDirUrl('team'),
      () =>
        new Promise<Response>((resolve) => {
          releaseChildren = () =>
            resolve(jsonResponse({ documents: [docEntry('team/notes')], truncated: false }));
        }),
    );
    await renderSeededTree();

    model.getItem('team/')?.expand();
    model.getItem('team/')?.collapse();
    model.getItem('team/')?.expand();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchUrls.filter((url) => url === lazyDirUrl('team'))).toHaveLength(1);

    releaseChildren();
    await waitFor(() => expect(model.items.has('team/notes.md')).toBe(true));
    // The single response splices once — no duplicate child rows.
    expect([...model.items.keys()].filter((path) => path === 'team/notes.md')).toHaveLength(1);
  });

  test('nested expansion lazily loads three levels, one fetch per folder', async () => {
    responseByUrl.set(lazyDirUrl('team'), () =>
      jsonResponse({ documents: [folderEntry('team/sub', true)], truncated: false }),
    );
    responseByUrl.set(lazyDirUrl('team/sub'), () =>
      jsonResponse({ documents: [docEntry('team/sub/deep')], truncated: false }),
    );
    await renderSeededTree();

    model.getItem('team/')?.expand();
    await waitFor(() => expect(model.items.has('team/sub/')).toBe(true));
    // The level-2 folder arrived as a directory item (its hasChildren stamp
    // came from team's depth-1 response), so it can itself expand.
    expect(model.getItem('team/sub/')?.isDirectory()).toBe(true);

    model.getItem('team/sub/')?.expand();
    await waitFor(() => expect(model.items.has('team/sub/deep.md')).toBe(true));

    expect(fetchUrls.filter((url) => url === lazyDirUrl('team'))).toHaveLength(1);
    expect(fetchUrls.filter((url) => url === lazyDirUrl('team/sub'))).toHaveLength(1);
    // Both ancestors stay open across the nested splices.
    expect(model.getItem('team/')?.isExpanded()).toBe(true);
    expect(model.getItem('team/sub/')?.isExpanded()).toBe(true);
  });

  test('a child response that loses to a refresh cycle is discarded while revalidation repopulates the folder', async () => {
    let releaseStaleChildren: () => void = () => {};
    let teamRequestCount = 0;
    responseByUrl.set(lazyDirUrl('team'), () => {
      teamRequestCount += 1;
      if (teamRequestCount === 1) {
        // First request hangs until released — it will lose to the refresh.
        return new Promise<Response>((resolve) => {
          releaseStaleChildren = () =>
            resolve(jsonResponse({ documents: [docEntry('team/stale')], truncated: false }));
        });
      }
      return jsonResponse({ documents: [docEntry('team/fresh')], truncated: false });
    });
    await renderSeededTree();

    model.getItem('team/')?.expand();
    await waitFor(() => expect(teamRequestCount).toBe(1));

    // External change: the CC1 'files' push triggers a root re-seed, which
    // supersedes the still-pending child fetch and then revalidates the
    // expanded folder — fresh children arrive without any user action.
    emitDocumentsChanged(['files']);
    await waitFor(() => expect(model.items.has('team/fresh.md')).toBe(true));
    expect(teamRequestCount).toBe(2);
    expect(model.getItem('team/')?.isExpanded()).toBe(true);

    // The superseded response lands late — it must not splice stale entries
    // over the revalidated level.
    releaseStaleChildren();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(model.items.has('team/stale.md')).toBe(false);
    expect([...model.items.keys()].sort()).toEqual([
      'README.md',
      'empty/',
      'team/',
      'team/fresh.md',
    ]);
  });

  test('expanding a folder the server marked childless fetches nothing', async () => {
    await renderSeededTree();
    const requestCountBefore = fetchUrls.length;

    model.getItem('empty/')?.expand();
    // Let any (wrong) fetch kick off before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchUrls.slice(requestCountBefore)).toEqual([]);
    expect(model.getItem('empty/')?.isExpanded()).toBe(true);
  });

  test('a failed child fetch surfaces the error alert and the folder stays re-expandable (QA-008)', async () => {
    let teamRequestCount = 0;
    responseByUrl.set(lazyDirUrl('team'), () => {
      teamRequestCount += 1;
      if (teamRequestCount === 1) return jsonResponse({ title: 'Folder walk failed' }, 500);
      return jsonResponse({ documents: [docEntry('team/notes')], truncated: false });
    });
    await renderSeededTree();

    model.getItem('team/')?.expand();

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent ?? '').toContain('Folder walk failed');
    });
    // The failure leaves the tree usable: the seeded level is intact and the
    // folder did not get poisoned into a fake "loaded" state.
    expect([...model.items.keys()].sort()).toEqual(['README.md', 'empty/', 'team/']);

    model.getItem('team/')?.collapse();
    model.getItem('team/')?.expand();
    await waitFor(() => expect(model.items.has('team/notes.md')).toBe(true));
    expect(teamRequestCount).toBe(2);
    // A successful child fetch clears the failure notice.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a network-level child fetch failure surfaces the unreachable-server alert and recovers (QA-008)', async () => {
    // `fetch` rejecting outright (connection refused, DNS failure) takes the
    // network-error branch — a different path and copy than the HTTP-error
    // test, so a refactor merging the two branches fails here.
    let teamRequestCount = 0;
    responseByUrl.set(lazyDirUrl('team'), () => {
      teamRequestCount += 1;
      if (teamRequestCount === 1) throw new TypeError('Failed to fetch');
      return jsonResponse({ documents: [docEntry('team/notes')], truncated: false });
    });
    await renderSeededTree();

    model.getItem('team/')?.expand();

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent ?? '').toContain('Could not reach server');
    });
    // The failure leaves the tree usable and the folder un-poisoned, exactly
    // like the HTTP-error case.
    expect([...model.items.keys()].sort()).toEqual(['README.md', 'empty/', 'team/']);

    model.getItem('team/')?.collapse();
    model.getItem('team/')?.expand();
    await waitFor(() => expect(model.items.has('team/notes.md')).toBe(true));
    expect(teamRequestCount).toBe(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('FileTree showAll scoped refresh', () => {
  let consoleWarnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mergedConfig = { appearance: { sidebar: {} } };
    showAllResponseFactory = () =>
      jsonResponse({
        documents: [folderEntry('team', true), folderEntry('empty', false), docEntry('README')],
        truncated: false,
      });
    responseByUrl = new Map();
    fetchUrls.length = 0;
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

  async function renderTreeWithTeamLoaded() {
    responseByUrl.set(lazyDirUrl('team'), () =>
      jsonResponse({ documents: [docEntry('team/notes')], truncated: false }),
    );
    const view = render(<FileTree />);
    await waitFor(() => expect(model.items.size).toBe(3));
    model.getItem('team/')?.expand();
    await waitFor(() => expect(model.items.has('team/notes.md')).toBe(true));
    return view;
  }

  test('a files signal revalidates the root level plus expanded folders only (QA-006 scope)', async () => {
    // Streamed root responses must drive the same revalidation as buffered
    // ones (the sibling tests cover the buffered arm).
    showAllResponseFactory = () =>
      new Response(
        `${[
          JSON.stringify(folderEntry('team', true)),
          JSON.stringify(folderEntry('empty', false)),
          JSON.stringify(docEntry('README')),
          JSON.stringify({ type: 'complete', truncated: false, count: 3 }),
        ].join('\n')}\n`,
        { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
      );
    await renderTreeWithTeamLoaded();
    const before = fetchUrls.length;

    emitDocumentsChanged(['files']);

    await waitFor(() => expect(fetchUrls.slice(before)).toContain(lazyDirUrl('team')));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const documentFetches = fetchUrls
      .slice(before)
      .filter((url) => url.startsWith('/api/documents'));
    // Exactly one depth-1 request per scope — the root plus the one expanded
    // folder. Unexpanded folders ('empty') are not revalidated, and nothing
    // falls back to the full recursive walk (showAll without depth=1).
    expect(documentFetches.sort()).toEqual([SHOW_ALL_DEPTH1_URL, lazyDirUrl('team')].sort());
    // The already-loaded children survived the re-seed and the folder stayed
    // open — the revalidation replaces levels in place, it does not reset the
    // tree to the bare root.
    expect(model.items.has('team/notes.md')).toBe(true);
    expect(model.getItem('team/')?.isExpanded()).toBe(true);
  });

  test('external create and delete inside an expanded folder land after the next files signal', async () => {
    responseByUrl.set(lazyDirUrl('team'), () =>
      jsonResponse({
        documents: [docEntry('team/notes'), folderEntry('team/sub', true)],
        truncated: false,
      }),
    );
    responseByUrl.set(lazyDirUrl('team/sub'), () =>
      jsonResponse({ documents: [docEntry('team/sub/deep')], truncated: false }),
    );
    render(<FileTree />);
    await waitFor(() => expect(model.items.size).toBe(3));
    model.getItem('team/')?.expand();
    await waitFor(() => expect(model.items.has('team/sub/')).toBe(true));
    model.getItem('team/sub/')?.expand();
    await waitFor(() => expect(model.items.has('team/sub/deep.md')).toBe(true));

    // External changes since the levels loaded: team/created.md was created,
    // the whole team/sub folder was deleted. The revalidation fetch for the
    // now-deleted team/sub directory returns an empty level.
    responseByUrl.set(lazyDirUrl('team'), () =>
      jsonResponse({
        documents: [docEntry('team/notes'), docEntry('team/created')],
        truncated: false,
      }),
    );
    responseByUrl.set(lazyDirUrl('team/sub'), () =>
      jsonResponse({ documents: [], truncated: false }),
    );

    emitDocumentsChanged(['files']);

    await waitFor(() => expect(model.items.has('team/created.md')).toBe(true));
    // The deleted folder is gone AND its previously-loaded descendants were
    // pruned with it — no phantom 'team/sub/' re-implied by an orphan path.
    expect(model.items.has('team/sub/')).toBe(false);
    expect(model.items.has('team/sub/deep.md')).toBe(false);
    expect(model.items.has('team/notes.md')).toBe(true);
    expect(model.getItem('team/')?.isExpanded()).toBe(true);
  });

  test('a burst of files signals coalesces into one trailing revalidation pass', async () => {
    await renderTreeWithTeamLoaded();
    // Production fetch rejects when its signal aborts; the shared mock
    // ignores signals on purpose (late resolutions exercise the generation
    // guard elsewhere), so the root URL gets a signal-faithful override
    // here — a superseded in-flight refresh must die instead of applying.
    responseByUrl.set(
      SHOW_ALL_DEPTH1_URL,
      (init) =>
        new Promise<Response>((resolve, reject) => {
          const abort = () => reject(new DOMException('aborted', 'AbortError'));
          if (init?.signal?.aborted) {
            abort();
            return;
          }
          init?.signal?.addEventListener('abort', abort);
          setTimeout(() => resolve(showAllResponseFactory()), 0);
        }),
    );
    const before = fetchUrls.length;

    emitDocumentsChanged(['files']);
    emitDocumentsChanged(['files']);
    emitDocumentsChanged(['files']);

    await waitFor(() =>
      expect(fetchUrls.slice(before).filter((url) => url === lazyDirUrl('team'))).toHaveLength(1),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Three signals collapse to the superseded in-flight run plus ONE
    // trailing re-run — not a pass per signal — and only the surviving pass
    // revalidates the expanded folder.
    expect(fetchUrls.slice(before).filter((url) => url === SHOW_ALL_DEPTH1_URL)).toHaveLength(2);
    expect(fetchUrls.slice(before).filter((url) => url === lazyDirUrl('team'))).toHaveLength(1);
    expect(model.items.has('team/notes.md')).toBe(true);
  });

  test('a collapsed folder is not revalidated by the signal and refetches on its next expand', async () => {
    await renderTreeWithTeamLoaded();
    model.getItem('team/')?.collapse();
    responseByUrl.set(lazyDirUrl('team'), () =>
      jsonResponse({ documents: [docEntry('team/renamed')], truncated: false }),
    );
    const before = fetchUrls.length;

    emitDocumentsChanged(['files']);

    await waitFor(() => expect(fetchUrls.slice(before)).toContain(SHOW_ALL_DEPTH1_URL));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Collapsed folders are outside the revalidation scope — only the root
    // level refreshed.
    expect(fetchUrls.slice(before).filter((url) => url === lazyDirUrl('team'))).toHaveLength(0);

    // The refresh cycle invalidated the per-cycle cache, so the next expand
    // refetches instead of serving the pre-refresh children.
    model.getItem('team/')?.expand();
    await waitFor(() => expect(model.items.has('team/renamed.md')).toBe(true));
    expect(model.items.has('team/notes.md')).toBe(false);
  });

  test('expanded children stay visible while their revalidation is still in flight', async () => {
    await renderTreeWithTeamLoaded();
    // The folder's revalidation hangs: the root re-seed has applied but the
    // child level has not answered yet — exactly the window where a
    // replace-the-world re-seed would blank every expanded folder on each
    // CC1 push.
    let releaseChildren: () => void = () => {};
    responseByUrl.set(
      lazyDirUrl('team'),
      () =>
        new Promise<Response>((resolve) => {
          releaseChildren = () =>
            resolve(jsonResponse({ documents: [docEntry('team/renamed')], truncated: false }));
        }),
    );
    const before = fetchUrls.length;

    emitDocumentsChanged(['files']);

    // The revalidation request going out proves the root level already
    // applied (the fan-out runs after the root splice).
    await waitFor(() =>
      expect(fetchUrls.slice(before).filter((url) => url === lazyDirUrl('team'))).toHaveLength(1),
    );
    expect(model.items.has('team/notes.md')).toBe(true);
    expect(model.getItem('team/')?.isExpanded()).toBe(true);

    releaseChildren();
    await waitFor(() => expect(model.items.has('team/renamed.md')).toBe(true));
    expect(model.items.has('team/notes.md')).toBe(false);
  });
});

describe('FileTree relaunch-aware reconnect (desktop auto-update)', () => {
  let consoleWarnSpy: ReturnType<typeof spyOn>;
  let fireRelaunching: () => void;
  let fireRelaunchFailed: () => void;
  let detachRelaunch: () => void;

  beforeEach(() => {
    mergedConfig = { appearance: { sidebar: {} } };
    showAllResponseFactory = () =>
      jsonResponse({ documents: [docEntry('README')], truncated: false });
    responseByUrl = new Map();
    fetchUrls.length = 0;
    model.items.clear();
    model.listeners.clear();
    model.focusedPath = null;
    model.selectedPaths = [];
    globalThis.fetch = makeFetchMock() as unknown as typeof fetch;
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    fireRelaunching = () => {};
    fireRelaunchFailed = () => {};
    // Drive the real relaunch-store through captured bridge callbacks —
    // the same singleton `useRelaunchInFlight` subscribes to.
    detachRelaunch = attachRelaunchStateSubscribers({
      onUpdateRelaunching: (cb: (info: { version: string }) => void) => {
        fireRelaunching = () => cb({ version: '9.9.9' });
        return () => {};
      },
      onUpdateRelaunchFailed: (cb: (info: { version: string; message?: string }) => void) => {
        fireRelaunchFailed = () => cb({ version: '9.9.9', message: 'aborted' });
        return () => {};
      },
    } as unknown as Parameters<typeof attachRelaunchStateSubscribers>[0]);
  });

  afterEach(() => {
    cleanup();
    detachRelaunch();
    // Reset the module singleton (flag + listeners) so it never leaks into a
    // sibling test.
    resetRelaunchStoreForTest();
    consoleWarnSpy.mockRestore();
  });

  test('shows a calm relaunch notice instead of the red error while a relaunch is in flight', async () => {
    render(<FileTree />);
    await waitFor(() => expect(model.items.size).toBe(1));

    // The server is intentionally torn down for the relaunch — listing fetches
    // now reject at the transport layer.
    showAllResponseFactory = () => {
      throw new TypeError('Failed to fetch');
    };
    fireRelaunching();

    await waitFor(() =>
      expect(screen.getByRole('status').textContent ?? '').toContain(
        'Relaunching to install the update',
      ),
    );
    // The honest-outage error is suppressed: no red alert during a known relaunch.
    expect(screen.queryByText('Could not reach server')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('self-heals when the relaunch aborts and the server returns', async () => {
    render(<FileTree />);
    await waitFor(() => expect(model.items.size).toBe(1));

    showAllResponseFactory = () => {
      throw new TypeError('Failed to fetch');
    };
    fireRelaunching();
    await waitFor(() =>
      expect(screen.getByRole('status').textContent ?? '').toContain(
        'Relaunching to install the update',
      ),
    );

    // Relaunch aborts: the app keeps running and the server comes back.
    showAllResponseFactory = () =>
      jsonResponse({ documents: [docEntry('README'), docEntry('AFTER')], truncated: false });
    fireRelaunchFailed();

    // The abort transition re-attempts the listing; success clears the calm
    // notice without waiting out the retry timer.
    await waitFor(() => expect(model.items.has('AFTER.md')).toBe(true));
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText('Could not reach server')).toBeNull();
  });

  test('falls back to the honest error when reachability fails with no relaunch underway', async () => {
    render(<FileTree />);
    await waitFor(() => expect(model.items.size).toBe(1));

    // No relaunch in flight — a genuine outage must still surface immediately.
    showAllResponseFactory = () => {
      throw new TypeError('Failed to fetch');
    };
    emitDocumentsChanged(['files']);

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent ?? '').toContain('Could not reach server'),
    );
    expect(screen.queryByText('Relaunching to install the update…')).toBeNull();
  });

  test('a lazy folder-children fetch failure during a relaunch shows the calm notice', async () => {
    // Flip the relaunch BEFORE mount so the start/abort flip effect doesn't fire
    // a racing root refresh — the only fetch we want to fail is the child one.
    fireRelaunching();
    showAllResponseFactory = () =>
      jsonResponse({
        documents: [folderEntry('team', true), docEntry('README')],
        truncated: false,
      });
    responseByUrl.set(lazyDirUrl('team'), () => {
      throw new TypeError('Failed to fetch');
    });
    render(<FileTree />);
    await waitFor(() => expect(model.items.has('team/')).toBe(true));

    // Expanding the folder fires the lazy child fetch (FileTree.tsx's
    // reportConnectivityFailure site) which rejects at the transport layer.
    model.getItem('team/')?.expand();

    await waitFor(() =>
      expect(screen.getByRole('status').textContent ?? '').toContain(
        'Relaunching to install the update',
      ),
    );
    expect(screen.queryByText('Could not reach server')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('FileTree only-markdown visibility', () => {
  let consoleWarnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mergedConfig = { appearance: { sidebar: {} } };
    showAllResponseFactory = () => jsonResponse({ documents: [] });
    responseByUrl = new Map();
    fetchUrls.length = 0;
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

  test('non-markdown leaves render with the toggle off — the default stays byte-identical', async () => {
    showAllResponseFactory = () =>
      jsonResponse({
        documents: [docEntry('README'), assetEntry('data.csv'), folderEntry('team', true)],
        truncated: false,
      });
    render(<FileTree />);

    await waitFor(() => expect(model.items.has('data.csv')).toBe(true));
    expect(model.items.has('README.md')).toBe(true);
    expect(model.items.has('team/')).toBe(true);
  });

  test('only-markdown ON hides non-markdown leaves; documents and folders (even markdown-empty ones) stay', async () => {
    mergedConfig = { appearance: { sidebar: { showOnlyMarkdownFiles: true } } };
    showAllResponseFactory = () =>
      jsonResponse({
        documents: [
          docEntry('README'),
          assetEntry('data.csv'),
          folderEntry('team', true),
          folderEntry('assets-only', true),
        ],
        truncated: false,
      });
    render(<FileTree />);

    await waitFor(() => expect(model.items.has('README.md')).toBe(true));
    // Folders are exempt from the filter — a folder with no markdown anywhere
    // still renders (it expands to empty rather than disappearing).
    expect(model.items.has('team/')).toBe(true);
    expect(model.items.has('assets-only/')).toBe(true);
    expect(model.items.has('data.csv')).toBe(false);
  });

  test('flipping only-markdown refetches through the scheduler and preserves folder expansion', async () => {
    showAllResponseFactory = () =>
      jsonResponse({
        documents: [docEntry('README'), assetEntry('data.csv'), folderEntry('team', true)],
        truncated: false,
      });
    responseByUrl.set(lazyDirUrl('team'), () =>
      jsonResponse({
        documents: [docEntry('team/notes'), assetEntry('team/data.json')],
        truncated: false,
      }),
    );
    const view = render(<FileTree />);
    await waitFor(() => expect(model.items.has('data.csv')).toBe(true));
    model.getItem('team/')?.expand();
    await waitFor(() => expect(model.items.has('team/data.json')).toBe(true));
    const rootFetchesBefore = fetchUrls.filter((url) => url === SHOW_ALL_DEPTH1_URL).length;

    mergedConfig = { appearance: { sidebar: { showOnlyMarkdownFiles: true } } };
    view.rerender(<FileTree />);

    // The flip re-fetches (root splice + expanded-folder revalidation) and the
    // re-applied filter drops every non-markdown leaf, including ones in the
    // already-loaded child level.
    await waitFor(() => expect(model.items.has('data.csv')).toBe(false));
    await waitFor(() => expect(model.items.has('team/data.json')).toBe(false));
    expect(model.items.has('README.md')).toBe(true);
    expect(model.items.has('team/notes.md')).toBe(true);
    // Expansion state carries across the flip — no reset-to-collapsed.
    expect(model.getItem('team/')?.isExpanded()).toBe(true);
    expect(fetchUrls.filter((url) => url === SHOW_ALL_DEPTH1_URL)).toHaveLength(
      rootFetchesBefore + 1,
    );

    // Flipping back off restores the default rendering — the toggle is pure
    // view state, nothing was lost.
    mergedConfig = { appearance: { sidebar: { showOnlyMarkdownFiles: false } } };
    view.rerender(<FileTree />);
    await waitFor(() => expect(model.items.has('data.csv')).toBe(true));
    await waitFor(() => expect(model.items.has('team/data.json')).toBe(true));
    expect(model.getItem('team/')?.isExpanded()).toBe(true);
  });

  test('only-markdown filters the streamed NDJSON seed — batches and the completion splice alike', async () => {
    mergedConfig = { appearance: { sidebar: { showOnlyMarkdownFiles: true } } };
    const lines = [
      JSON.stringify(assetEntry('data.csv')),
      JSON.stringify(docEntry('README')),
      JSON.stringify(folderEntry('team', true)),
      JSON.stringify({ type: 'complete', truncated: false, count: 3 }),
    ].join('\n');
    showAllResponseFactory = () =>
      new Response(`${lines}\n`, {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      });
    render(<FileTree />);

    await waitFor(() => expect([...model.items.keys()].sort()).toEqual(['README.md', 'team/']));
  });

  test('only-markdown filters lazy folder children; a markdown-empty folder expands to empty and stays open', async () => {
    mergedConfig = { appearance: { sidebar: { showOnlyMarkdownFiles: true } } };
    showAllResponseFactory = () =>
      jsonResponse({
        documents: [folderEntry('team', true), folderEntry('assets-only', true)],
        truncated: false,
      });
    responseByUrl.set(lazyDirUrl('team'), () =>
      jsonResponse({
        documents: [docEntry('team/notes'), assetEntry('team/data.json')],
        truncated: false,
      }),
    );
    responseByUrl.set(lazyDirUrl('assets-only'), () =>
      jsonResponse({ documents: [assetEntry('assets-only/pic.png')], truncated: false }),
    );
    render(<FileTree />);
    await waitFor(() => expect(model.items.size).toBe(2));

    model.getItem('team/')?.expand();
    await waitFor(() => expect(model.items.has('team/notes.md')).toBe(true));
    expect(model.items.has('team/data.json')).toBe(false);

    model.getItem('assets-only/')?.expand();
    await waitFor(() => expect(fetchUrls).toContain(lazyDirUrl('assets-only')));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The level was fetched and filtered to zero: the folder renders no
    // children but keeps its expanded state — it is not dropped or collapsed.
    expect(model.items.has('assets-only/pic.png')).toBe(false);
    expect(model.getItem('assets-only/')?.isExpanded()).toBe(true);
  });

  test('hidden-files and only-markdown compose per axis: a dot-path doc needs H on and passes M', async () => {
    mergedConfig = {
      appearance: { sidebar: { showHiddenFiles: false, showOnlyMarkdownFiles: true } },
    };
    showAllResponseFactory = () =>
      jsonResponse({
        documents: [docEntry('.hidden-note'), assetEntry('.hidden-data.csv'), docEntry('README')],
        truncated: false,
      });
    const view = render(<FileTree />);

    // Hidden files off: both dot-path entries drop regardless of kind.
    await waitFor(() => expect(model.items.has('README.md')).toBe(true));
    expect(model.items.has('.hidden-note.md')).toBe(false);
    expect(model.items.has('.hidden-data.csv')).toBe(false);

    mergedConfig = {
      appearance: { sidebar: { showHiddenFiles: true, showOnlyMarkdownFiles: true } },
    };
    view.rerender(<FileTree />);

    // Both on: the dot-path markdown doc passes both axes; the dot-path csv
    // clears the hidden axis but still fails only-markdown (AND composition).
    await waitFor(() => expect(model.items.has('.hidden-note.md')).toBe(true));
    expect(model.items.has('README.md')).toBe(true);
    expect(model.items.has('.hidden-data.csv')).toBe(false);
  });
});

describe('FileTree filtered-to-zero empty state', () => {
  let consoleWarnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mergedConfig = { appearance: { sidebar: {} } };
    showAllResponseFactory = () => jsonResponse({ documents: [] });
    responseByUrl = new Map();
    fetchUrls.length = 0;
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

  test('only-markdown hiding every row of a non-empty project shows the reset explainer', async () => {
    mergedConfig = { appearance: { sidebar: { showOnlyMarkdownFiles: true } } };
    showAllResponseFactory = () =>
      jsonResponse({
        documents: [assetEntry('data.csv'), assetEntry('logo.png')],
        truncated: false,
      });
    render(<FileTree />);

    await waitFor(() => expect(screen.queryByTestId('file-tree-filtered-to-zero')).toBeTruthy());
    expect(screen.queryByTestId('reset-view-filters')).toBeTruthy();
    expect(screen.queryByText('No files yet.')).toBeNull();
  });

  test('a truly empty project keeps the existing empty state even while only-markdown is on', async () => {
    mergedConfig = { appearance: { sidebar: { showOnlyMarkdownFiles: true } } };
    showAllResponseFactory = () => jsonResponse({ documents: [], truncated: false });
    render(<FileTree />);

    await waitFor(() => expect(screen.queryByText('No files yet.')).toBeTruthy());
    expect(screen.queryByTestId('file-tree-filtered-to-zero')).toBeNull();
  });

  test('a dot-only project at defaults keeps the pre-feature empty state', async () => {
    showAllResponseFactory = () =>
      jsonResponse({
        documents: [folderEntry('.scratch', true), docEntry('.draft')],
        truncated: false,
      });
    render(<FileTree />);

    await waitFor(() => expect(screen.queryByText('No files yet.')).toBeTruthy());
    expect(screen.queryByTestId('file-tree-filtered-to-zero')).toBeNull();
  });

  test('the streamed NDJSON listing classifies filtered-to-zero at completion', async () => {
    mergedConfig = { appearance: { sidebar: { showOnlyMarkdownFiles: true } } };
    const lines = [
      JSON.stringify(assetEntry('data.csv')),
      JSON.stringify(assetEntry('logo.png')),
      JSON.stringify({ type: 'complete', truncated: false, count: 2 }),
    ].join('\n');
    showAllResponseFactory = () =>
      new Response(`${lines}\n`, {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      });
    render(<FileTree />);

    await waitFor(() => expect(screen.queryByTestId('file-tree-filtered-to-zero')).toBeTruthy());
    expect(screen.queryByText('No files yet.')).toBeNull();
  });
});

describe('FileTree show-ok-folders visibility', () => {
  let consoleWarnSpy: ReturnType<typeof spyOn>;

  const SHOW_OK_DEPTH1_URL = '/api/documents?showAll=true&showOk=true&dir=&depth=1';
  const lazyOkDirUrl = (dir: string) =>
    `/api/documents?showAll=true&showOk=true&dir=${encodeURIComponent(dir)}&depth=1`;

  beforeEach(() => {
    mergedConfig = { appearance: { sidebar: {} } };
    showAllResponseFactory = () => jsonResponse({ documents: [] });
    responseByUrl = new Map();
    fetchUrls.length = 0;
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

  test('show-ok ON requests the listing with showOk=true and renders .ok rows', async () => {
    mergedConfig = { appearance: { sidebar: { showOkFolders: true } } };
    responseByUrl.set(SHOW_OK_DEPTH1_URL, () =>
      jsonResponse({
        documents: [docEntry('README'), folderEntry('.ok', true)],
        truncated: false,
      }),
    );
    render(<FileTree />);

    await waitFor(() => expect(model.items.has('.ok/')).toBe(true));
    expect(model.items.has('README.md')).toBe(true);
    // The reveal is request-scoped: the plain showAll listing is never issued
    // while the axis is on.
    expect(fetchUrls).toContain(SHOW_OK_DEPTH1_URL);
    expect(fetchUrls).not.toContain(SHOW_ALL_DEPTH1_URL);
  });

  test('the default listing never passes showOk — off stays byte-identical to today', async () => {
    showAllResponseFactory = () =>
      jsonResponse({
        documents: [docEntry('README'), folderEntry('team', true)],
        truncated: false,
      });
    render(<FileTree />);

    await waitFor(() => expect(model.items.has('README.md')).toBe(true));
    expect(fetchUrls.some((url) => url.includes('showOk'))).toBe(false);
  });

  test('hidden-files on does not reveal .ok rows and does not request showOk', async () => {
    mergedConfig = { appearance: { sidebar: { showHiddenFiles: true } } };
    // The default listing already ships the bare `.ok` folder row (skills
    // carve-out); with only the H axis on the client must keep dropping it.
    showAllResponseFactory = () =>
      jsonResponse({
        documents: [docEntry('README'), folderEntry('.scratch', true), folderEntry('.ok', true)],
        truncated: false,
      });
    render(<FileTree />);

    await waitFor(() => expect(model.items.has('.scratch/')).toBe(true));
    expect(model.items.has('.ok/')).toBe(false);
    expect(fetchUrls.some((url) => url.includes('showOk'))).toBe(false);
  });

  test('expanding a revealed .ok folder lazy-fetches its children with showOk=true', async () => {
    mergedConfig = { appearance: { sidebar: { showOkFolders: true } } };
    responseByUrl.set(SHOW_OK_DEPTH1_URL, () =>
      jsonResponse({
        documents: [docEntry('README'), folderEntry('.ok', true)],
        truncated: false,
      }),
    );
    responseByUrl.set(lazyOkDirUrl('.ok'), () =>
      jsonResponse({
        documents: [folderEntry('.ok/templates', true), assetEntry('.ok/config.yml')],
        truncated: false,
      }),
    );
    render(<FileTree />);
    await waitFor(() => expect(model.items.has('.ok/')).toBe(true));

    model.getItem('.ok/')?.expand();

    await waitFor(() => expect(model.items.has('.ok/templates/')).toBe(true));
    expect(model.items.has('.ok/config.yml')).toBe(true);
    expect(fetchUrls).toContain(lazyOkDirUrl('.ok'));
  });

  test('flipping show-ok refetches through the scheduler and preserves expansion state', async () => {
    showAllResponseFactory = () =>
      jsonResponse({
        documents: [docEntry('README'), folderEntry('team', true)],
        truncated: false,
      });
    responseByUrl.set(lazyDirUrl('team'), () =>
      jsonResponse({ documents: [docEntry('team/notes')], truncated: false }),
    );
    responseByUrl.set(SHOW_OK_DEPTH1_URL, () =>
      jsonResponse({
        documents: [docEntry('README'), folderEntry('team', true), folderEntry('.ok', true)],
        truncated: false,
      }),
    );
    responseByUrl.set(lazyOkDirUrl('team'), () =>
      jsonResponse({ documents: [docEntry('team/notes')], truncated: false }),
    );
    const view = render(<FileTree />);
    await waitFor(() => expect(model.items.has('team/')).toBe(true));
    model.getItem('team/')?.expand();
    await waitFor(() => expect(model.items.has('team/notes.md')).toBe(true));

    mergedConfig = { appearance: { sidebar: { showOkFolders: true } } };
    view.rerender(<FileTree />);

    await waitFor(() => expect(model.items.has('.ok/')).toBe(true));
    // Expansion state carries across the flip — no reset-to-collapsed.
    expect(model.getItem('team/')?.isExpanded()).toBe(true);

    // Flipping back off refetches the plain listing; the root splice prunes
    // the `.ok` row and the default view is restored.
    mergedConfig = { appearance: { sidebar: { showOkFolders: false } } };
    view.rerender(<FileTree />);
    await waitFor(() => expect(model.items.has('.ok/')).toBe(false));
    expect(model.items.has('README.md')).toBe(true);
    expect(model.getItem('team/')?.isExpanded()).toBe(true);
  });

  test('an expanded .ok folder stays expanded across a refresh cycle', async () => {
    mergedConfig = { appearance: { sidebar: { showOkFolders: true } } };
    responseByUrl.set(SHOW_OK_DEPTH1_URL, () =>
      jsonResponse({
        documents: [docEntry('README'), folderEntry('.ok', true)],
        truncated: false,
      }),
    );
    responseByUrl.set(lazyOkDirUrl('.ok'), () =>
      jsonResponse({ documents: [folderEntry('.ok/templates', true)], truncated: false }),
    );
    render(<FileTree />);
    await waitFor(() => expect(model.items.has('.ok/')).toBe(true));
    model.getItem('.ok/')?.expand();
    await waitFor(() => expect(model.items.has('.ok/templates/')).toBe(true));

    // External change signal → root revalidation → model reset. The expanded
    // `.ok/` folder must survive the reset's expansion-preservation pass.
    emitDocumentsChanged();
    await waitFor(() =>
      expect(fetchUrls.filter((url) => url === SHOW_OK_DEPTH1_URL).length).toBeGreaterThan(1),
    );
    await waitFor(() => expect(model.getItem('.ok/')?.isExpanded()).toBe(true));
    expect(model.items.has('.ok/templates/')).toBe(true);
  });
});
