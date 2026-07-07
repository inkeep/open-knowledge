import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MouseEventHandler, ReactNode } from 'react';
import type { FileEntry } from './file-tree-utils';
import type { ResolvedNavigationTarget } from './navigation-targets';

type MenuItemProps = {
  children?: ReactNode;
  checked?: boolean;
  disabled?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  onSelect?: () => void;
  [key: string]: unknown;
};

function PassThrough({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

function MenuItem({
  children,
  checked,
  disabled,
  onCheckedChange,
  onSelect,
  variant: _variant,
  ...props
}: MenuItemProps) {
  const handleClick = () => {
    onCheckedChange?.(!checked);
    onSelect?.();
  };
  if (checked !== undefined) {
    return (
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={checked}
        disabled={disabled}
        onClick={handleClick}
        {...props}
      >
        {children}
      </button>
    );
  }
  return (
    <button type="button" role="menuitem" disabled={disabled} onClick={handleClick} {...props}>
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

const toastSuccessMock = mock(() => {});
const toastErrorMock = mock(() => {});
const addPageMock = mock(() => {});
const openTargetMock = mock(() => {});
const notifySidebarFileSelectedMock = mock(() => {});
const closeTabsMock = mock(() => {});
const closeDocumentMock = mock(() => {});
const closeAndClearForRenameMock = mock(async () => {});
const remapTabsForRenameMock = mock(() => {});
const dispatchHandoffMock = mock(async () => ({ ok: true as const }));

const DOCUMENTS: FileEntry[] = [
  {
    kind: 'folder',
    path: 'notes',
    size: 0,
    modified: '2026-05-18T00:00:00.000Z',
  },
  {
    kind: 'document',
    docName: 'notes/source',
    docExt: '.mdx',
    size: 1,
    modified: '2026-05-18T00:00:00.000Z',
  },
  {
    kind: 'asset',
    path: 'images/logo.png',
    assetExt: '.png',
    mediaKind: 'image',
    referencedBy: ['notes/source'],
    size: 1,
    modified: '2026-05-18T00:00:00.000Z',
  } as FileEntry,
];

interface FetchCall {
  url: string;
  init?: RequestInit;
}

class StubItem {
  expanded = false;
  selected = false;

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

  focus() {}
}

class StubModel {
  focusedPath: string | null = null;
  selectedPaths: string[] = [];
  items = new Map<string, StubItem>();
  startRenaming = mock(() => {});

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

  resetPaths(paths: string[]) {
    this.items.clear();
    for (const path of paths) {
      this.items.set(path, new StubItem(path, path.endsWith('/')));
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

  move() {}
  remove() {}
}

let model = new StubModel();
let menuItem: { kind: 'file' | 'directory'; path: string };
let closeMenuMock = mock(() => {});
let duplicateResponse: unknown;
let duplicateStatus = 200;
let duplicateGate: Promise<void> | null = null;
let duplicateFetchError: Error | null = null;
let fetchCalls: FetchCall[] = [];
// Root-level entries the server "grows" mid-test (e.g. a folder the duplicate
// just created on disk). The post-duplicate docs refresh re-reads the disk
// walk, so a duplicated root folder surfaces here — the lazy splice keeps a
// client optimistic add only for children of folders the server still returns,
// not for a brand-new top-level folder.
let extraDocuments: FileEntry[] = [];
let okignoreBindingMock: {
  current: () => string;
  patch: ReturnType<typeof mock>;
} | null = null;
let projectLocalBindingMock: { patch: ReturnType<typeof mock> } | null = null;
let mergedConfigMock: {
  appearance?: { sidebar?: { showHiddenFiles?: boolean } };
} | null = null;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function duplicateCalls() {
  return fetchCalls.filter((call) => call.url === '/api/duplicate-path');
}

function expectMenuOrder(labels: readonly RegExp[]) {
  const items = Array.from(
    document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]'),
  );
  let cursor = -1;
  for (const label of labels) {
    const next = items.findIndex(
      (item, index) => index > cursor && label.test(item.textContent ?? ''),
    );
    expect(next, `expected menu item ${label} after index ${cursor}`).toBeGreaterThan(cursor);
    cursor = next;
  }
}

function makeFetchMock() {
  return mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push({ url, init });
    if (url.startsWith('/api/documents'))
      return jsonResponse({ documents: [...DOCUMENTS, ...extraDocuments] });
    if (url === '/api/workspace') {
      return jsonResponse({
        contentDir: '/tmp/open-knowledge',
        pathSeparator: '/',
        symlinkResolved: true,
      });
    }
    if (url === '/api/duplicate-path') {
      if (duplicateGate) await duplicateGate;
      if (duplicateFetchError) throw duplicateFetchError;
      // A folder duplicate creates the copy on disk; the next disk-walk listing
      // returns it (the file-watcher round-trip, simulated).
      const dup = duplicateResponse as { kind?: string; path?: string } | undefined;
      if (duplicateStatus === 200 && dup?.kind === 'folder' && typeof dup.path === 'string') {
        extraDocuments = [
          { kind: 'folder', path: dup.path, size: 0, modified: '2026-05-18T00:00:00.000Z' },
        ];
      }
      return jsonResponse(duplicateResponse, duplicateStatus);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

mock.module('sonner', () => ({
  toast: {
    success: toastSuccessMock,
    error: toastErrorMock,
  },
}));

mock.module('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

mock.module('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    activeDocName: 'notes/source',
    activeTarget: { kind: 'doc', target: 'notes/source', docName: 'notes/source' },
    closeTabs: closeTabsMock,
    closeDocument: closeDocumentMock,
    closeAndClearDocument: closeAndClearForRenameMock,
    closeAndClearForDelete: closeAndClearForRenameMock,
    closeAndClearForRename: closeAndClearForRenameMock,
    getPoolActiveDocName: () => 'notes/source',
    poolHas: () => true,
    isNewTabActive: false,
    openTarget: openTargetMock,
    prewarm: () => {},
    remapTabsForRename: remapTabsForRenameMock,
  }),
}));

mock.module('@/components/PageListContext', () => ({
  usePageList: () => ({ addPage: addPageMock, pageMeta: new Map() }),
}));

mock.module('./ui/sidebar', () => ({
  useSidebar: () => ({ notifySidebarFileSelected: notifySidebarFileSelectedMock }),
}));

mock.module('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    okignoreBinding: okignoreBindingMock,
    projectLocalBinding: projectLocalBindingMock,
    merged: mergedConfigMock,
  }),
}));

mock.module('./handoff/useInstalledAgents', () => ({
  useInstalledAgents: () => ({ states: {} }),
}));

mock.module('./handoff/useHandoffDispatch', () => ({
  buildFolderHandoffInput: () => null,
  buildHandoffInput: () => null,
  useHandoffDispatch: () => ({ dispatch: dispatchHandoffMock }),
}));

mock.module('./handoff/OpenInAgentContextSubmenu', () => ({
  OpenInAgentContextSubmenu: () => (
    <button type="button" role="menuitem" data-testid="file-tree-menu-open-in-agent">
      Open with AI
    </button>
  ),
}));

mock.module('./sidebar-hover-prewarm', () => ({
  cancelHoverPrewarm: () => {},
  scheduleHoverPrewarm: () => {},
}));

mock.module('@/components/ui/button', () => ({
  Button: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

mock.module('@/components/ui/dialog', () => ({
  Dialog: PassThrough,
}));

mock.module('@/components/ui/dropdown-menu', () => ({
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

mock.module('@/components/ui/skeleton', () => ({
  Skeleton: ({ className }: { className?: string }) => <span className={className} />,
}));

mock.module('@/components/DeleteConfirmationDialog', () => ({
  DeleteConfirmationDialog: () => null,
}));

mock.module('@/components/NewItemDialog', () => ({
  NewItemDialog: () => null,
}));

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
    renderContextMenu,
    onClickCapture,
    onMouseMove,
    onMouseLeave,
  }: {
    renderContextMenu?: (
      item: typeof menuItem,
      context: { close: typeof closeMenuMock },
    ) => ReactNode;
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
    >
      <button type="button" data-testid="tree-focus-target">
        Focus target
      </button>
      {renderContextMenu?.(menuItem, { close: closeMenuMock })}
    </div>
  ),
}));

const { FileTree } = await import('./FileTree');
const { emitFileTreeMenuActionDuplicate } = await import('@/lib/file-tree-menu-action-events');

function renderFileTree() {
  return render(<FileTree />);
}

describe('FileTree duplicate action runtime behavior', () => {
  let consoleWarnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    model = new StubModel();
    menuItem = { kind: 'file', path: 'notes/source.mdx' };
    closeMenuMock = mock(() => {});
    duplicateResponse = {
      kind: 'file',
      path: 'notes/source copy',
      duplicatedDocNames: ['notes/source copy'],
    };
    duplicateStatus = 200;
    duplicateGate = null;
    duplicateFetchError = null;
    fetchCalls = [];
    extraDocuments = [];
    okignoreBindingMock = null;
    projectLocalBindingMock = null;
    // These duplicate/rename tests don't depend on visibility config; the
    // tree loads through the default disk-walk listing.
    mergedConfigMock = null;
    globalThis.fetch = makeFetchMock() as unknown as typeof fetch;
    toastSuccessMock.mockClear();
    toastErrorMock.mockClear();
    addPageMock.mockClear();
    openTargetMock.mockClear();
    notifySidebarFileSelectedMock.mockClear();
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleWarnSpy.mockRestore();
  });

  test('context-menu Duplicate posts the selected file target and applies a valid success response', async () => {
    const user = userEvent.setup();
    renderFileTree();

    const duplicate = await screen.findByRole('menuitem', { name: /duplicate/i });
    expect(duplicate.querySelector('svg[aria-hidden="true"]')).not.toBeNull();

    fetchCalls = [];
    await user.click(duplicate);

    await waitFor(() => expect(duplicateCalls()).toHaveLength(1));
    const [call] = duplicateCalls();
    expect(call?.url).toBe('/api/duplicate-path');
    expect(call?.init?.method).toBe('POST');
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      kind: 'file',
      path: 'notes/source',
    });
    expect(addPageMock).toHaveBeenCalledWith('notes/source copy');
    expect(openTargetMock).toHaveBeenCalledWith(
      {
        kind: 'doc',
        target: 'notes/source copy',
        docName: 'notes/source copy',
      },
      { tabBehavior: 'replace-active' },
    );
    await waitFor(() => expect(model.getItem('notes/source copy.mdx')).not.toBeNull());
    expect(closeMenuMock).toHaveBeenCalled();
  });

  test('file context-menu Hide appends an anchored okignore pattern and shows reversible copy', async () => {
    okignoreBindingMock = {
      current: () => '',
      patch: mock(() => ({ ok: true })),
    };
    const user = userEvent.setup();
    renderFileTree();

    const hide = (await screen.findByTestId('file-tree-menu-hide')) as HTMLButtonElement;
    expect(hide.disabled).toBe(false);
    expect(hide.textContent).toContain('Hide this file');

    await user.click(hide);

    expect(closeMenuMock).toHaveBeenCalled();
    expect(okignoreBindingMock.patch).toHaveBeenCalledWith('/notes/source.mdx\n');
    expect(toastSuccessMock).toHaveBeenCalledWith('Hidden “source”', {
      description: 'Manage hidden files in Settings → Ignore patterns.',
      duration: 5000,
    });
  });

  test('Hide is disabled without the shared okignore binding and dedupes existing patterns', async () => {
    renderFileTree();
    expect(((await screen.findByTestId('file-tree-menu-hide')) as HTMLButtonElement).disabled).toBe(
      true,
    );
    cleanup();

    okignoreBindingMock = {
      current: () => '/notes/source.mdx\n',
      patch: mock(() => ({ ok: true })),
    };
    const user = userEvent.setup();
    renderFileTree();

    await user.click(await screen.findByTestId('file-tree-menu-hide'));

    expect(closeMenuMock).toHaveBeenCalled();
    expect(okignoreBindingMock.patch).not.toHaveBeenCalled();
    expect(toastSuccessMock).not.toHaveBeenCalledWith('Hidden “source”', expect.anything());
  });

  test('folder context-menu Duplicate posts the selected folder target and navigates to the copy', async () => {
    menuItem = { kind: 'directory', path: 'notes/' };
    duplicateResponse = {
      kind: 'folder',
      path: 'notes copy',
      duplicatedDocNames: ['notes copy/index'],
    };
    const user = userEvent.setup();
    renderFileTree();

    fetchCalls = [];
    await user.click(await screen.findByRole('menuitem', { name: /duplicate/i }));

    await waitFor(() => expect(duplicateCalls()).toHaveLength(1));
    expect(JSON.parse(String(duplicateCalls()[0]?.init?.body))).toEqual({
      kind: 'folder',
      path: 'notes',
    });
    expect(addPageMock).toHaveBeenCalledWith('notes copy/index');
    expect(openTargetMock).toHaveBeenCalledWith(
      {
        kind: 'folder',
        target: 'notes copy',
        folderPath: 'notes copy',
      },
      { tabBehavior: 'replace-active' },
    );
    await waitFor(() => expect(model.getItem('notes copy/')).not.toBeNull());
    expect(toastSuccessMock).toHaveBeenCalledWith('Folder duplicated', {
      description: 'notes copy',
    });
    expect(closeMenuMock).toHaveBeenCalled();
  });

  test('folder context menu exposes runtime order, subtree actions, visibility toggle, and folder hide', async () => {
    menuItem = { kind: 'directory', path: 'notes/' };
    okignoreBindingMock = {
      current: () => '',
      patch: mock(() => ({ ok: true })),
    };
    projectLocalBindingMock = { patch: mock(() => ({ ok: true })) };
    mergedConfigMock = {
      appearance: { sidebar: { showHiddenFiles: true } },
    };
    const user = userEvent.setup();
    renderFileTree();

    await screen.findByRole('menuitem', { name: /duplicate/i });
    expectMenuOrder([
      /New file/,
      /New from template/,
      /New folder/,
      /Open with AI/,
      /Copy path/,
      /Show hidden files/,
      /Expand all/,
      /Duplicate/,
      /Rename/,
      /Hide folder/,
      /Delete/,
    ]);

    const showHidden = screen.getByTestId('file-tree-menu-show-hidden-files');
    expect(showHidden.getAttribute('aria-checked')).toBe('true');

    await user.click(showHidden);
    expect(projectLocalBindingMock.patch).toHaveBeenCalledWith({
      appearance: { sidebar: { showHiddenFiles: false } },
    });

    await user.click(screen.getByRole('menuitem', { name: /expand all/i }));
    expect(model.getItem('notes/')?.isExpanded()).toBe(true);

    await user.click(screen.getByTestId('file-tree-menu-hide'));
    expect(okignoreBindingMock.patch).toHaveBeenCalledWith('/notes/\n');
    expect(toastSuccessMock).toHaveBeenCalledWith('Hidden folder “notes”', {
      description: 'Manage hidden files in Settings → Ignore patterns.',
      duration: 5000,
    });
  });

  test('asset context menu keeps path actions and suppresses document-only actions', async () => {
    menuItem = { kind: 'file', path: 'images/logo.png' };
    renderFileTree();

    await waitFor(() => {
      expect(screen.queryByTestId('file-tree-menu-hide')).toBeNull();
    });
    expect(screen.queryByTestId('file-tree-menu-open-in-agent')).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /duplicate/i })).toBeNull();
    expect(screen.getByRole('menuitem', { name: /rename/i })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /^delete/i })).toBeTruthy();
    expect(screen.queryByTestId('file-tree-menu-show-hidden-files')).toBeNull();
    expect(screen.getByRole('menuitem', { name: /copy path/i })).toBeTruthy();
  });

  test('duplicate response is schema-validated before UI reconciliation', async () => {
    duplicateResponse = {
      kind: 'file',
      path: 42,
      duplicatedDocNames: 'not-an-array',
    };
    const user = userEvent.setup();
    renderFileTree();

    fetchCalls = [];
    await user.click(await screen.findByRole('menuitem', { name: /duplicate/i }));

    await waitFor(() => expect(duplicateCalls()).toHaveLength(1));
    expect(addPageMock).not.toHaveBeenCalled();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[parse-server-response] schema drift:',
      'duplicate-path',
      'bodyShape=',
      ['kind', 'path', 'duplicatedDocNames'],
      'issues=',
      expect.any(Array),
    );
    expect(addPageMock).not.toHaveBeenCalled();
    expect(openTargetMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Duplicate succeeded but the sidebar may be out of date — refresh to resync',
    );
  });

  test('duplicate error responses show the server problem title and do not reconcile', async () => {
    duplicateStatus = 409;
    duplicateResponse = {
      type: 'urn:ok:error:doc-already-exists',
      title: 'A file at the duplicate destination already exists.',
      status: 409,
      instance: 'urn:uuid:00000000-0000-4000-8000-000000000000',
    };
    const user = userEvent.setup();
    renderFileTree();

    fetchCalls = [];
    await user.click(await screen.findByRole('menuitem', { name: /duplicate/i }));

    await waitFor(() => expect(duplicateCalls()).toHaveLength(1));
    expect(addPageMock).not.toHaveBeenCalled();
    expect(openTargetMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith(
      'A file at the duplicate destination already exists.',
    );
  });

  test('duplicate fetch failures show a generic error toast and do not reconcile', async () => {
    duplicateFetchError = new Error('network offline');
    const user = userEvent.setup();
    renderFileTree();

    fetchCalls = [];
    await user.click(await screen.findByRole('menuitem', { name: /duplicate/i }));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith('Could not duplicate item', {
        description: 'network offline',
      }),
    );
    expect(duplicateCalls()).toHaveLength(1);
    expect(addPageMock).not.toHaveBeenCalled();
    expect(openTargetMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  test('duplicate busy guard suppresses overlapping duplicate requests', async () => {
    let releaseDuplicate: () => void = () => {};
    duplicateGate = new Promise<void>((resolve) => {
      releaseDuplicate = resolve;
    });
    const user = userEvent.setup();
    renderFileTree();

    const duplicate = await screen.findByRole('menuitem', { name: /duplicate/i });
    fetchCalls = [];
    await user.click(duplicate);
    await waitFor(() => expect(duplicateCalls()).toHaveLength(1));

    await user.click(duplicate);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(duplicateCalls()).toHaveLength(1);

    releaseDuplicate();
    await waitFor(() =>
      expect(toastSuccessMock).toHaveBeenCalledWith('File duplicated', {
        description: 'notes/source copy',
      }),
    );
  });

  test('Cmd/Ctrl+D duplicates the selected tree item without using the context menu', async () => {
    renderFileTree();
    await screen.findByRole('menuitem', { name: /duplicate/i });
    fetchCalls = [];

    model.focusedPath = null;
    model.selectedPaths = ['notes/source.mdx'];
    screen.getByTestId('tree-focus-target').focus();
    fireEvent.keyDown(document, { key: 'd', ctrlKey: true });

    await waitFor(() => expect(duplicateCalls()).toHaveLength(1));
    expect(JSON.parse(String(duplicateCalls()[0]?.init?.body))).toEqual({
      kind: 'file',
      path: 'notes/source',
    });
  });

  test('Cmd/Ctrl+D duplicates the selected folder tree item', async () => {
    duplicateResponse = {
      kind: 'folder',
      path: 'notes copy',
      duplicatedDocNames: ['notes copy/index'],
    };
    renderFileTree();
    await screen.findByRole('menuitem', { name: /duplicate/i });
    fetchCalls = [];

    model.focusedPath = null;
    model.selectedPaths = ['notes/'];
    screen.getByTestId('tree-focus-target').focus();
    fireEvent.keyDown(document, { key: 'd', ctrlKey: true });

    await waitFor(() => expect(duplicateCalls()).toHaveLength(1));
    expect(JSON.parse(String(duplicateCalls()[0]?.init?.body))).toEqual({
      kind: 'folder',
      path: 'notes',
    });
  });

  test('Cmd/Ctrl+D ignores asset rows', async () => {
    renderFileTree();
    await screen.findByRole('menuitem', { name: /duplicate/i });
    fetchCalls = [];

    model.focusedPath = 'images/logo.png';
    model.selectedPaths = ['images/logo.png'];
    screen.getByTestId('tree-focus-target').focus();
    fireEvent.keyDown(document, { key: 'd', ctrlKey: true });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(duplicateCalls()).toHaveLength(0);
  });

  test('desktop duplicate event bus resolves doc and folder targets through the same duplicate path', async () => {
    renderFileTree();
    await screen.findByRole('menuitem', { name: /duplicate/i });
    fetchCalls = [];

    await act(async () => {
      emitFileTreeMenuActionDuplicate({
        kind: 'doc',
        target: 'notes/source',
        docName: 'notes/source',
      } satisfies ResolvedNavigationTarget);
      await Promise.resolve();
    });

    await waitFor(() => expect(duplicateCalls()).toHaveLength(1));
    expect(JSON.parse(String(duplicateCalls()[0]?.init?.body))).toEqual({
      kind: 'file',
      path: 'notes/source',
    });

    await act(async () => {
      emitFileTreeMenuActionDuplicate({
        kind: 'folder',
        target: 'notes',
        folderPath: 'notes',
      } satisfies ResolvedNavigationTarget);
      await Promise.resolve();
    });

    await waitFor(() => expect(duplicateCalls()).toHaveLength(2));
    expect(JSON.parse(String(duplicateCalls()[1]?.init?.body))).toEqual({
      kind: 'folder',
      path: 'notes',
    });
  });

  test('desktop duplicate event bus ignores unsupported asset targets with a structured warning', async () => {
    renderFileTree();
    await screen.findByRole('menuitem', { name: /duplicate/i });
    fetchCalls = [];

    act(() => {
      emitFileTreeMenuActionDuplicate({
        kind: 'asset',
        target: 'images/logo.png',
        assetPath: 'images/logo.png',
        mediaKind: 'image',
      } satisfies ResolvedNavigationTarget);
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(duplicateCalls()).toHaveLength(0);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'file-tree-menu-action-duplicate-unsupported-kind',
        kind: 'asset',
      }),
    );
  });
});
