import { cleanup, render, waitFor } from '@testing-library/react';
import type { MouseEventHandler, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { FileEntry } from './file-tree-utils';

type MenuItemProps = {
  children?: ReactNode;
  disabled?: boolean;
  onSelect?: () => void;
  [key: string]: unknown;
};

function PassThrough({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

function MenuItem({ children, disabled, onSelect, variant: _variant, ...props }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => onSelect?.()}
      {...props}
    >
      {children}
    </button>
  );
}

function MenuContent({ children }: { children?: ReactNode }) {
  return <div role="menu">{children}</div>;
}

function MenuSeparator() {
  return <hr />;
}

const toastSuccessMock = vi.fn(() => {});
const toastErrorMock = vi.fn(() => {});
const addPageMock = vi.fn(() => {});
const openTargetMock = vi.fn(() => {});
const notifySidebarFileSelectedMock = vi.fn(() => {});
const closeTabsMock = vi.fn(() => {});
const closeDocumentMock = vi.fn(() => {});
const reconcileLocalRenameMock = vi.fn(async () => {});
const reconcileLocalRemovalMock = vi.fn(async () => {});
const dispatchHandoffMock = vi.fn(async () => ({ ok: true as const }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const INITIAL_DOCUMENTS: FileEntry[] = [
  {
    kind: 'document',
    docName: 'aaa',
    docExt: '.md',
    size: 1,
    modified: '2026-05-22T00:00:00.000Z',
  },
  {
    kind: 'document',
    docName: 'foo',
    docExt: '.md',
    size: 1,
    modified: '2026-05-22T00:00:00.000Z',
  },
  {
    kind: 'document',
    docName: 'zzz',
    docExt: '.md',
    size: 1,
    modified: '2026-05-22T00:00:00.000Z',
  },
];

interface FetchCall {
  url: string;
  init?: RequestInit;
}

class StubItem {
  expanded = false;
  selected = false;
  focusCount = 0;

  constructor(
    readonly path: string,
    private readonly directory: boolean,
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
  }

  collapse() {
    this.expanded = false;
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

  focus() {
    this.focusCount += 1;
  }
}

class StubModel {
  focusedPath: string | null = null;
  selectedPaths: string[] = [];
  items = new Map<string, StubItem>();
  startRenaming = vi.fn(() => {});

  getFocusedPath() {
    return this.focusedPath;
  }

  getFocusedIndex() {
    if (this.focusedPath == null) return -1;
    const paths = Array.from(this.items.keys());
    return paths.indexOf(this.focusedPath);
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

  resetPaths(paths: string[]) {
    this.items.clear();
    for (const path of paths) {
      this.items.set(path, new StubItem(path, path.endsWith('/')));
    }
    if (this.focusedPath != null && !this.items.has(this.focusedPath)) {
      this.focusedPath = paths.length > 0 ? paths[0] : null;
    }
  }

  subscribe() {
    return () => {};
  }

  onMutation() {
    return () => {};
  }

  isSearchOpen() {
    return false;
  }

  add(path: string) {
    this.items.set(path, new StubItem(path, path.endsWith('/')));
  }

  move(source: string, dest: string) {
    const item = this.items.get(source);
    if (item == null) {
      throw new Error(`Source path does not exist: "${source}"`);
    }
    if (this.focusedPath === source) {
      this.focusedPath = dest;
    }
    this.selectedPaths = this.selectedPaths.map((p) => (p === source ? dest : p));
    this.items.delete(source);
    this.items.set(dest, new StubItem(dest, item.isDirectory()));
  }

  remove(path: string) {
    this.items.delete(path);
    if (this.focusedPath === path) {
      this.focusedPath = null;
    }
  }

  focusPath(path: string) {
    this.focusedPath = path;
  }
}

let model = new StubModel();
let capturedOptions: unknown = null;
let documentsFetchResult: FileEntry[] = INITIAL_DOCUMENTS;
let renameResponseBody: unknown = {
  renamed: [{ fromDocName: 'foo', toDocName: 'bar' }],
  renamedAssets: [],
  rewrittenDocs: [],
};
let renameStatus = 200;
let fetchCalls: FetchCall[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeFetchMock() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push({ url, init });
    if (url.startsWith('/api/documents')) {
      return jsonResponse({ documents: documentsFetchResult });
    }
    if (url === '/api/workspace') {
      return jsonResponse({
        contentDir: '/tmp/open-knowledge',
        pathSeparator: '/',
        symlinkResolved: true,
      });
    }
    if (url === '/api/rename-path') {
      return jsonResponse(renameResponseBody, renameStatus);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

vi.doMock('sonner', () => ({
  toast: {
    success: toastSuccessMock,
    error: toastErrorMock,
  },
}));

vi.doMock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    activeDocName: 'foo',
    activeTarget: { kind: 'doc', target: 'foo', docName: 'foo' },
    closeTabs: closeTabsMock,
    closeDocument: closeDocumentMock,
    isNewTabActive: false,
    openTarget: openTargetMock,
    prewarm: () => {},
    reconcileLocalRename: reconcileLocalRenameMock,
    reconcileLocalRemoval: reconcileLocalRemovalMock,
  }),
}));

vi.doMock('@/components/PageListContext', () => ({
  usePageList: () => ({ addPage: addPageMock, pageMeta: new Map() }),
}));

vi.doMock('./ui/sidebar', () => ({
  useSidebar: () => ({ notifySidebarFileSelected: notifySidebarFileSelectedMock }),
}));

vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    okignoreBinding: null,
    projectLocalBinding: null,
    merged: null,
  }),
}));

vi.doMock('./handoff/useInstalledAgents', () => ({
  useInstalledAgents: () => ({ states: {} }),
}));

vi.doMock('./handoff/useHandoffDispatch', () => ({
  buildFolderHandoffInput: () => null,
  buildHandoffInput: () => null,
  useHandoffDispatch: () => ({ dispatch: dispatchHandoffMock }),
}));

vi.doMock('./handoff/OpenInAgentContextSubmenu', () => ({
  OpenInAgentContextSubmenu: () => null,
}));

vi.doMock('./sidebar-hover-prewarm', () => ({
  cancelHoverPrewarm: () => {},
  scheduleHoverPrewarm: () => {},
}));

vi.doMock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.doMock('@/components/ui/dialog', () => ({
  Dialog: PassThrough,
}));

vi.doMock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: PassThrough,
  DropdownMenuCheckboxItem: MenuItem,
  DropdownMenuContent: MenuContent,
  DropdownMenuItem: MenuItem,
  DropdownMenuSeparator: MenuSeparator,
  DropdownMenuSub: PassThrough,
  DropdownMenuSubContent: MenuContent,
  DropdownMenuSubTrigger: MenuItem,
  DropdownMenuTrigger: PassThrough,
}));

vi.doMock('@/components/ui/skeleton', () => ({
  Skeleton: ({ className }: { className?: string }) => <span className={className} />,
}));

vi.doMock('@/components/DeleteConfirmationDialog', () => ({
  DeleteConfirmationDialog: () => null,
}));

vi.doMock('@/components/NewItemDialog', () => ({
  NewItemDialog: () => null,
}));

vi.doMock('@/components/TrashFailureModal', () => ({
  TrashFailureModal: () => null,
  coerceTrashFailureReason: (reason: string) => reason,
}));

vi.doMock('@/components/use-selection-mirror', () => ({
  asDirectoryHandle: (item: StubItem | null) => (item?.isDirectory() ? item : null),
  useSelectionMirror: () => {},
}));

vi.doMock('@pierre/trees', () => ({
  FILE_TREE_TAG_NAME: 'ok-file-tree',
  themeToTreeStyles: () => ({}),
}));

vi.doMock('@pierre/trees/react', () => ({
  useFileTree: (options: unknown) => {
    capturedOptions = options;
    return { model };
  },
  FileTree: ({
    onClickCapture,
    onMouseMove,
    onMouseLeave,
  }: {
    onClickCapture?: MouseEventHandler<HTMLDivElement>;
    onMouseMove?: MouseEventHandler<HTMLDivElement>;
    onMouseLeave?: MouseEventHandler<HTMLDivElement>;
  }) => (
    <div
      data-testid="fake-pierre-tree"
      role="tree"
      onClickCapture={onClickCapture}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
    />
  ),
}));

const { FileTree } = await import('./FileTree');

interface RenameEvent {
  sourcePath: string;
  destinationPath: string;
  isFolder: boolean;
}

function simulatePierreCommitRename(
  source: string,
  extensionlessDest: string,
  isFolder: boolean,
): void {
  const options = capturedOptions as { renaming?: { onRename?: (e: RenameEvent) => void } } | null;
  const onRename = options?.renaming?.onRename;
  if (!onRename) {
    throw new Error('onRename callback missing from captured Pierre options');
  }
  onRename({ sourcePath: source, destinationPath: extensionlessDest, isFolder });
  model.move(source, extensionlessDest);
}

describe('FileTree post-rename Pierre/React store reconciliation', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    model = new StubModel();
    model.resetPaths(['aaa.md', 'foo.md', 'zzz.md']);
    capturedOptions = null;
    documentsFetchResult = INITIAL_DOCUMENTS;
    renameResponseBody = {
      renamed: [{ fromDocName: 'foo', toDocName: 'bar' }],
      renamedAssets: [],
      rewrittenDocs: [],
    };
    renameStatus = 200;
    fetchCalls = [];
    globalThis.fetch = makeFetchMock() as unknown as typeof fetch;
    toastSuccessMock.mockClear();
    toastErrorMock.mockClear();
    addPageMock.mockClear();
    openTargetMock.mockClear();
    notifySidebarFileSelectedMock.mockClear();
    reconcileLocalRenameMock.mockClear();
    reconcileLocalRemovalMock.mockClear();
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleWarnSpy.mockRestore();
  });

  test('PRIMARY — after applyRenamedDocuments settles, model focusedPath is the canonical with-extension form', async () => {
    render(<FileTree />);

    await waitFor(() => {
      expect(capturedOptions).not.toBeNull();
    });
    await waitFor(() => {
      expect(model.getItem('foo.md')).not.toBeNull();
    });

    model.focusPath('foo.md');
    model.selectedPaths = ['foo.md'];
    expect(model.getFocusedPath()).toBe('foo.md');
    expect(model.getSelectedPaths()).toEqual(['foo.md']);

    fetchCalls = [];
    simulatePierreCommitRename('foo.md', 'bar', false);

    await waitFor(() => {
      expect(model.getFocusedPath()).toBe('bar.md');
    });
    expect(model.getSelectedPaths()).toEqual(['bar.md']);
    expect(addPageMock).toHaveBeenCalledWith('bar');
  });

  test('SECONDARY — a forced post-rename resetPaths preserves focus on the renamed row (not the index-0 fallback)', async () => {
    render(<FileTree />);

    await waitFor(() => {
      expect(capturedOptions).not.toBeNull();
    });
    await waitFor(() => {
      expect(model.getItem('foo.md')).not.toBeNull();
    });

    model.focusPath('foo.md');
    expect(model.getFocusedIndex()).toBe(1);

    simulatePierreCommitRename('foo.md', 'bar', false);

    await waitFor(() => {
      expect(model.getFocusedPath()).toBe('bar.md');
    });

    model.resetPaths(['aaa.md', 'bar.md', 'zzz.md']);

    expect(model.getFocusedPath()).toBe('bar.md');
    expect(model.getFocusedIndex()).toBe(1);
  });

  test('waits for local rename reconciliation before adding the destination page or resetting the tree', async () => {
    const reconciliation = deferred();
    reconcileLocalRenameMock.mockImplementation(() => reconciliation.promise);
    render(<FileTree />);

    await waitFor(() => {
      expect(capturedOptions).not.toBeNull();
      expect(model.getItem('foo.md')).not.toBeNull();
    });

    simulatePierreCommitRename('foo.md', 'bar', false);

    await waitFor(() => {
      expect(reconcileLocalRenameMock).toHaveBeenCalledWith({
        renamed: [{ fromDocName: 'foo', toDocName: 'bar' }],
        renamedFolders: [],
        renamedAssets: [],
        additionalRemovedDocNames: [],
      });
    });
    expect(addPageMock).not.toHaveBeenCalled();
    expect(model.getItem('bar.md')).toBeNull();

    reconciliation.resolve();

    await waitFor(() => {
      expect(addPageMock).toHaveBeenCalledWith('bar');
      expect(model.getItem('bar.md')).not.toBeNull();
    });
  });

  test('DRAG_DROP — Pierre store already canonical post-drop; reconciliation guard short-circuits without throwing', async () => {
    renameResponseBody = {
      renamed: [{ fromDocName: 'foo', toDocName: 'subfolder/foo' }],
      renamedAssets: [],
      rewrittenDocs: [],
    };

    render(<FileTree />);

    await waitFor(() => {
      expect(capturedOptions).not.toBeNull();
    });
    await waitFor(() => {
      expect(model.getItem('foo.md')).not.toBeNull();
    });

    model.focusPath('foo.md');
    model.move('foo.md', 'subfolder/foo.md');
    expect(model.getFocusedPath()).toBe('subfolder/foo.md');

    const options = capturedOptions as {
      renaming?: { onRename?: (e: RenameEvent) => void };
    } | null;
    const onRename = options?.renaming?.onRename;
    if (!onRename) {
      throw new Error('onRename callback missing');
    }
    onRename({ sourcePath: 'foo.md', destinationPath: 'subfolder/foo.md', isFolder: false });

    await waitFor(() => {
      expect(addPageMock).toHaveBeenCalledWith('subfolder/foo');
    });

    expect(model.getFocusedPath()).toBe('subfolder/foo.md');
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  test('FOLDER_CASCADE — children pre-canonical in Pierre store; reconciliation guard short-circuits per child', async () => {
    renameResponseBody = {
      renamed: [
        { fromDocName: 'notes/a', toDocName: 'essays/a' },
        { fromDocName: 'notes/b', toDocName: 'essays/b' },
      ],
      renamedAssets: [],
      rewrittenDocs: [],
    };
    documentsFetchResult = [
      {
        kind: 'document',
        docName: 'notes/a',
        docExt: '.md',
        size: 1,
        modified: '2026-05-22T00:00:00.000Z',
      },
      {
        kind: 'document',
        docName: 'notes/b',
        docExt: '.md',
        size: 1,
        modified: '2026-05-22T00:00:00.000Z',
      },
    ];

    render(<FileTree />);

    await waitFor(() => {
      expect(capturedOptions).not.toBeNull();
    });
    await waitFor(() => {
      expect(model.getItem('notes/a.md')).not.toBeNull();
    });

    model.focusPath('notes/a.md');
    model.move('notes/a.md', 'essays/a.md');
    model.move('notes/b.md', 'essays/b.md');
    expect(model.getFocusedPath()).toBe('essays/a.md');

    const options = capturedOptions as {
      renaming?: { onRename?: (e: RenameEvent) => void };
    } | null;
    const onRename = options?.renaming?.onRename;
    if (!onRename) {
      throw new Error('onRename callback missing');
    }
    onRename({ sourcePath: 'notes/', destinationPath: 'essays/', isFolder: true });

    await waitFor(() => {
      expect(addPageMock).toHaveBeenCalledWith('essays/a');
    });

    expect(model.getFocusedPath()).toBe('essays/a.md');
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  test('NULL_SOURCE — server returns fromDocName absent from current state; source==null guard short-circuits', async () => {
    renameResponseBody = {
      renamed: [{ fromDocName: 'nonexistent', toDocName: 'whatever' }],
      renamedAssets: [],
      rewrittenDocs: [],
    };

    render(<FileTree />);
    await waitFor(() => {
      expect(capturedOptions).not.toBeNull();
    });
    await waitFor(() => {
      expect(model.getItem('foo.md')).not.toBeNull();
    });

    model.focusPath('foo.md');
    model.selectedPaths = ['foo.md'];
    const focusBefore = model.getFocusedPath();
    const itemsBefore = Array.from(model.items.keys()).sort();

    const options = capturedOptions as {
      renaming?: { onRename?: (e: RenameEvent) => void };
    } | null;
    const onRename = options?.renaming?.onRename;
    if (!onRename) {
      throw new Error('onRename callback missing');
    }
    onRename({
      sourcePath: 'nonexistent.md',
      destinationPath: 'whatever',
      isFolder: false,
    });

    await waitFor(() => {
      expect(addPageMock).toHaveBeenCalledWith('whatever');
    });

    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(model.getFocusedPath()).toBe(focusBefore);
    expect(model.getSelectedPaths()).toEqual(['foo.md']);
    expect(Array.from(model.items.keys()).sort()).toEqual(itemsBefore);
  });
});
