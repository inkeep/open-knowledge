import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MouseEventHandler, ReactNode } from 'react';
import type { FileEntry } from './file-tree-utils';

// Controls the mocked git-sync hook's hasRemote signal per test.
let hasRemote = true;
// Captures the input runShareAction receives.
let lastShareInput: unknown;
const runShareActionMock = mock(async (input: unknown) => {
  lastShareInput = input;
  return { kind: 'copied' as const, shareUrl: 'https://example.test/x', branch: 'main' };
});

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

const DOCUMENTS: FileEntry[] = [
  { kind: 'folder', path: 'notes', size: 0, modified: '2026-05-18T00:00:00.000Z' },
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
  add(path: string) {
    this.items.set(path, new StubItem(path, path.endsWith('/')));
  }
  move() {}
  remove() {}
  subscribe() {
    return () => {};
  }
  onMutation() {
    return () => {};
  }
  isSearchOpen() {
    return false;
  }
}

let model = new StubModel();
let menuItem: { kind: 'file' | 'directory'; path: string };
let closeMenuMock = mock(() => {});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeFetchMock() {
  return mock(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('/api/documents')) return jsonResponse({ documents: DOCUMENTS });
    if (url === '/api/workspace') {
      return jsonResponse({
        contentDir: '/tmp/open-knowledge',
        pathSeparator: '/',
        symlinkResolved: true,
      });
    }
    // Share goes through the mocked runShareAction; sync-status is mocked too.
    return jsonResponse({});
  });
}

mock.module('sonner', () => ({
  toast: { success: toastSuccessMock, error: toastErrorMock },
}));

mock.module('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

mock.module('@/hooks/use-git-sync-status', () => ({
  useGitSyncStatusDetailed: () => ({
    status: { hasRemote, syncEnabled: hasRemote, behind: 0, ahead: 0 },
    fetchError: null,
  }),
  useGitSyncStatus: () => ({ hasRemote, syncEnabled: hasRemote, behind: 0, ahead: 0 }),
}));

mock.module('@/lib/share/clipboard-adapter', () => ({
  scheduleClipboardWrite: async () => {},
}));

mock.module('@/lib/share/run-share-action', () => ({
  buildDocShareInput: (docName: string) => ({ kind: 'doc', docName }),
  buildFolderShareInput: (folderRelativePath: string) => ({ kind: 'folder', folderRelativePath }),
  runShareAction: runShareActionMock,
}));

mock.module('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    activeDocName: 'notes/source',
    activeTarget: { kind: 'doc', target: 'notes/source', docName: 'notes/source' },
    closeTabs: () => {},
    closeDocument: () => {},
    closeAndClearDocument: async () => {},
    closeAndClearForDelete: async () => {},
    closeAndClearForRename: async () => {},
    getPoolActiveDocName: () => 'notes/source',
    poolHas: () => true,
    isNewTabActive: false,
    openTarget: () => {},
    prewarm: () => {},
    remapTabsForRename: () => {},
  }),
}));

mock.module('@/components/PageListContext', () => ({
  usePageList: () => ({ addPage: () => {}, pageMeta: new Map() }),
}));

mock.module('./ui/sidebar', () => ({
  useSidebar: () => ({ notifySidebarFileSelected: () => {} }),
}));

mock.module('@/lib/config-provider', () => ({
  useConfigContext: () => ({ okignoreBinding: null, projectLocalBinding: null, merged: null }),
}));

mock.module('./handoff/useInstalledAgents', () => ({
  useInstalledAgents: () => ({ states: {} }),
}));

mock.module('./handoff/useHandoffDispatch', () => ({
  buildFolderHandoffInput: () => null,
  buildHandoffInput: () => null,
  useHandoffDispatch: () => ({ dispatch: async () => ({ ok: true as const }) }),
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

mock.module('@/components/ui/dialog', () => ({ Dialog: PassThrough }));

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
      {renderContextMenu?.(menuItem, { close: closeMenuMock })}
    </div>
  ),
}));

const { FileTree } = await import('./FileTree');

function renderFileTree() {
  return render(<FileTree />);
}

describe('FileTree context-menu Share action', () => {
  let consoleLogSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    model = new StubModel();
    menuItem = { kind: 'file', path: 'notes/source.mdx' };
    closeMenuMock = mock(() => {});
    hasRemote = true;
    lastShareInput = undefined;
    globalThis.fetch = makeFetchMock() as unknown as typeof fetch;
    runShareActionMock.mockClear();
    toastSuccessMock.mockClear();
    toastErrorMock.mockClear();
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleLogSpy.mockRestore();
  });

  test('a doc row shows Share and dispatches a doc-scope share input', async () => {
    const user = userEvent.setup();
    renderFileTree();

    const share = await screen.findByTestId('file-tree-menu-share');
    expect(share.querySelector('svg[aria-hidden="true"]')).not.toBeNull();

    await user.click(share);

    expect(closeMenuMock).toHaveBeenCalled();
    await waitFor(() => expect(runShareActionMock).toHaveBeenCalledTimes(1));
    expect(lastShareInput).toMatchObject({ kind: 'doc', docName: 'notes/source', hasRemote: true });
  });

  test('a folder row dispatches a folder-scope share input', async () => {
    menuItem = { kind: 'directory', path: 'notes/' };
    const user = userEvent.setup();
    renderFileTree();

    await user.click(await screen.findByTestId('file-tree-menu-share'));

    await waitFor(() => expect(runShareActionMock).toHaveBeenCalledTimes(1));
    expect(lastShareInput).toMatchObject({ kind: 'folder', folderRelativePath: 'notes' });
  });

  test('an asset row does not show Share (no shareable doc path)', async () => {
    menuItem = { kind: 'file', path: 'images/logo.png' };
    renderFileTree();

    // Wait for the menu to render (Reveal/Copy path are always present for files).
    await screen.findByText('Copy path');
    expect(screen.queryByTestId('file-tree-menu-share')).toBeNull();
  });

  test('Share is hidden when the project has no GitHub remote', async () => {
    hasRemote = false;
    renderFileTree();

    await screen.findByText('Copy path');
    expect(screen.queryByTestId('file-tree-menu-share')).toBeNull();
  });
});
