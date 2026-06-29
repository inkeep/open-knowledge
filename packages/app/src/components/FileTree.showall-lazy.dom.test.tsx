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
    await waitFor(() =>
      expect([...model.items.keys()].sort()).toEqual(['README.md', 'empty/', 'team/']),
    );
    expect(fetchUrls.filter((u) => u.includes('showAll=true') && !u.includes('depth=1'))).toEqual(
      [],
    );
  });

  test('unresolved config still seeds the disk-walk root — it is the only listing mode', async () => {
    mergedConfig = null;
    showAllResponseFactory = () =>
      jsonResponse({
        documents: [folderEntry('team', true), docEntry('README')],
        truncated: false,
      });
    render(<FileTree />);

    await screen.findByTestId('fake-pierre-tree');
    await waitFor(() => expect(fetchUrls).toContain(SHOW_ALL_DEPTH1_URL));
    expect(fetchUrls).not.toContain('/api/documents');
    await waitFor(() => expect([...model.items.keys()].sort()).toEqual(['README.md', 'team/']));
  });

  test('Show hidden files alone gates dot-segment entries in the disk-walk listing', async () => {
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
    expect(model.getItem('team/')?.isDirectory()).toBe(true);
    expect(model.getItem('empty/')?.isDirectory()).toBe(true);
    expect(model.getItem('README.md')?.isDirectory()).toBe(false);
  });

  test('a truncated depth-1 level still drives the truncation notice (QA-002 wiring)', async () => {
    showAllResponseFactory = () =>
      jsonResponse({
        documents: [docEntry('a'), docEntry('b'), docEntry('c')],
        truncated: true,
      });
    render(<FileTree />);

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
    await waitFor(() => {
      expect(screen.getByRole('status').textContent ?? '').toContain('Showing the first 2 items');
    });
  });

  test('a server-emitted NDJSON error line surfaces its problem title, not the connectivity copy', async () => {
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
    expect(model.getItem('team/sub/')?.isDirectory()).toBe(true);

    model.getItem('team/sub/')?.expand();
    await waitFor(() => expect(model.items.has('team/sub/deep.md')).toBe(true));

    expect(fetchUrls.filter((url) => url === lazyDirUrl('team'))).toHaveLength(1);
    expect(fetchUrls.filter((url) => url === lazyDirUrl('team/sub'))).toHaveLength(1);
    expect(model.getItem('team/')?.isExpanded()).toBe(true);
    expect(model.getItem('team/sub/')?.isExpanded()).toBe(true);
  });

  test('a child response that loses to a refresh cycle is discarded while revalidation repopulates the folder', async () => {
    let releaseStaleChildren: () => void = () => {};
    let teamRequestCount = 0;
    responseByUrl.set(lazyDirUrl('team'), () => {
      teamRequestCount += 1;
      if (teamRequestCount === 1) {
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

    emitDocumentsChanged(['files']);
    await waitFor(() => expect(model.items.has('team/fresh.md')).toBe(true));
    expect(teamRequestCount).toBe(2);
    expect(model.getItem('team/')?.isExpanded()).toBe(true);

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
    expect([...model.items.keys()].sort()).toEqual(['README.md', 'empty/', 'team/']);

    model.getItem('team/')?.collapse();
    model.getItem('team/')?.expand();
    await waitFor(() => expect(model.items.has('team/notes.md')).toBe(true));
    expect(teamRequestCount).toBe(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a network-level child fetch failure surfaces the unreachable-server alert and recovers (QA-008)', async () => {
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
    expect(documentFetches.sort()).toEqual([SHOW_ALL_DEPTH1_URL, lazyDirUrl('team')].sort());
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
    expect(model.items.has('team/sub/')).toBe(false);
    expect(model.items.has('team/sub/deep.md')).toBe(false);
    expect(model.items.has('team/notes.md')).toBe(true);
    expect(model.getItem('team/')?.isExpanded()).toBe(true);
  });

  test('a burst of files signals coalesces into one trailing revalidation pass', async () => {
    await renderTreeWithTeamLoaded();
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
    expect(fetchUrls.slice(before).filter((url) => url === lazyDirUrl('team'))).toHaveLength(0);

    model.getItem('team/')?.expand();
    await waitFor(() => expect(model.items.has('team/renamed.md')).toBe(true));
    expect(model.items.has('team/notes.md')).toBe(false);
  });

  test('expanded children stay visible while their revalidation is still in flight', async () => {
    await renderTreeWithTeamLoaded();
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
    resetRelaunchStoreForTest();
    consoleWarnSpy.mockRestore();
  });

  test('shows a calm relaunch notice instead of the red error while a relaunch is in flight', async () => {
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

    showAllResponseFactory = () =>
      jsonResponse({ documents: [docEntry('README'), docEntry('AFTER')], truncated: false });
    fireRelaunchFailed();

    await waitFor(() => expect(model.items.has('AFTER.md')).toBe(true));
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText('Could not reach server')).toBeNull();
  });

  test('falls back to the honest error when reachability fails with no relaunch underway', async () => {
    render(<FileTree />);
    await waitFor(() => expect(model.items.size).toBe(1));

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
