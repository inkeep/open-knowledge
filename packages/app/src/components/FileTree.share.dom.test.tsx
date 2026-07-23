import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MouseEventHandler, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { FileEntry } from './file-tree-utils';

// Controls the mocked git-sync hook's hasRemote signal per test.
let hasRemote = true;
// Captures the input runShareAction receives.
let lastShareInput: unknown;
const runShareActionMock = vi.fn(async (input: unknown) => {
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

const toastSuccessMock = vi.fn(() => {});
const toastErrorMock = vi.fn(() => {});

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
  startRenaming = vi.fn(() => {});
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
let closeMenuMock = vi.fn(() => {});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeFetchMock() {
  return vi.fn(async (input: RequestInfo | URL) => {
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

vi.doMock('sonner', () => ({
  toast: { success: toastSuccessMock, error: toastErrorMock },
}));

vi.doMock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

vi.doMock('@/hooks/use-git-sync-status', () => ({
  useGitSyncStatusDetailed: () => ({
    status: { hasRemote, syncEnabled: hasRemote, behind: 0, ahead: 0 },
    fetchError: null,
  }),
  useGitSyncStatus: () => ({ hasRemote, syncEnabled: hasRemote, behind: 0, ahead: 0 }),
}));

vi.doMock('@/lib/share/clipboard-adapter', () => ({
  scheduleClipboardWrite: async () => {},
}));

vi.doMock('@/lib/share/run-share-action', () => ({
  buildDocShareInput: (docName: string) => ({ kind: 'doc', docName }),
  buildFolderShareInput: (folderRelativePath: string) => ({ kind: 'folder', folderRelativePath }),
  runShareAction: runShareActionMock,
}));

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    activeDocName: 'notes/source',
    activeTarget: { kind: 'doc', target: 'notes/source', docName: 'notes/source' },
    closeTabs: () => {},
    closeDocument: () => {},
    isNewTabActive: false,
    openTarget: () => {},
    prewarm: () => {},
    reconcileLocalRemoval: async () => {},
    reconcileLocalRename: async () => {},
  }),
}));

vi.doMock('@/components/PageListContext', () => ({
  usePageList: () => ({ addPage: () => {}, pageMeta: new Map() }),
}));

vi.doMock('./ui/sidebar', () => ({
  useSidebar: () => ({ notifySidebarFileSelected: () => {} }),
}));

vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({ okignoreBinding: null, projectLocalBinding: null, merged: null }),
}));

vi.doMock('./handoff/useInstalledAgents', () => ({
  useInstalledAgents: () => ({ states: {} }),
}));

vi.doMock('./handoff/useHandoffDispatch', () => ({
  buildFolderHandoffInput: () => null,
  buildHandoffInput: () => null,
  useHandoffDispatch: () => ({ dispatch: async () => ({ ok: true as const }) }),
}));

vi.doMock('./handoff/OpenInAgentContextSubmenu', () => ({
  OpenInAgentContextSubmenu: () => (
    <button type="button" role="menuitem" data-testid="file-tree-menu-open-in-agent">
      Open with AI
    </button>
  ),
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

vi.doMock('@/components/ui/dialog', () => ({ Dialog: PassThrough }));

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

vi.doMock('@/components/NewItemDialog', () => ({ NewItemDialog: () => null }));

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
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    model = new StubModel();
    menuItem = { kind: 'file', path: 'notes/source.mdx' };
    closeMenuMock = vi.fn(() => {});
    hasRemote = true;
    lastShareInput = undefined;
    globalThis.fetch = makeFetchMock() as unknown as typeof fetch;
    runShareActionMock.mockClear();
    toastSuccessMock.mockClear();
    toastErrorMock.mockClear();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
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
