import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MouseEventHandler, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { folderTabId } from '@/editor/editor-tabs';
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
const pageMetaMock = new Map<string, { size: number }>();
const pagesMock = new Set<string>();
const openTargetMock = vi.fn(() => {});
const notifySidebarFileSelectedMock = vi.fn(() => {});
const closeTabsMock = vi.fn(() => {});
const closeDocumentMock = vi.fn(() => {});
const reconcileLocalRenameMock = vi.fn(async () => {});
const reconcileLocalRemovalMock = vi.fn(async () => {});
const dispatchHandoffMock = vi.fn(async () => ({ ok: true as const }));

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
    docExt: '.md',
    size: 1,
    modified: '2026-05-18T00:00:00.000Z',
  },
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

  removeListeners: Array<(event: { path: string }) => void> = [];

  subscribe() {
    return () => {};
  }

  onMutation(type: string, listener: (event: { path: string }) => void) {
    if (type === 'remove') this.removeListeners.push(listener);
    return () => {};
  }

  emitRemove(path: string) {
    for (const listener of this.removeListeners) listener({ path });
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
let closeMenuMock = vi.fn(() => {});
let createResponse: unknown;
let createStatus = 200;
let createGate: Promise<void> | null = null;
let createFetchError: Error | null = null;
let deletePathStatus = 200;
let deletePathResponse: unknown = { ok: true };
let deletePathFetchError: Error | null = null;
let fetchCalls: FetchCall[] = [];
let folderTemplates: Array<{
  name: string;
  title?: string;
  path: string;
  source_folder: string;
  scope: 'local' | 'inherited';
}> = [];
let folderConfigStatus: 'ready' | 'loading' = 'ready';
let lastFolderConfigPath: string | null = null;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createPageCalls() {
  return fetchCalls.filter((call) => call.url === '/api/create-page');
}

function deletePathCalls() {
  return fetchCalls.filter((call) => call.url === '/api/delete-path');
}

function makeFetchMock() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push({ url, init });
    if (url.startsWith('/api/documents')) return jsonResponse({ documents: DOCUMENTS });
    if (url === '/api/workspace') {
      return jsonResponse({
        contentDir: '/tmp/open-knowledge',
        pathSeparator: '/',
        symlinkResolved: true,
      });
    }
    if (url === '/api/create-page') {
      if (createGate) await createGate;
      if (createFetchError) throw createFetchError;
      return jsonResponse(createResponse, createStatus);
    }
    if (url === '/api/create-folder') {
      return jsonResponse(createResponse, createStatus);
    }
    if (url === '/api/delete-path') {
      if (deletePathFetchError) throw deletePathFetchError;
      return jsonResponse(deletePathResponse, deletePathStatus);
    }
    if (url === '/api/rename-path') return jsonResponse({ renamed: [] }, 200);
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
    activeDocName: 'notes/source',
    activeTarget: { kind: 'doc', target: 'notes/source', docName: 'notes/source' },
    closeTabs: closeTabsMock,
    closeDocument: closeDocumentMock,
    isNewTabActive: false,
    openTarget: openTargetMock,
    prewarm: () => {},
    reconcileLocalRemoval: reconcileLocalRemovalMock,
    reconcileLocalRename: reconcileLocalRenameMock,
    setSkillsSidebar: () => {},
  }),
}));

vi.doMock('@/components/PageListContext', () => ({
  usePageList: () => ({ addPage: addPageMock, pageMeta: pageMetaMock, pages: pagesMock }),
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

vi.doMock('@/hooks/use-folder-config', () => ({
  useFolderConfig: (folderPath: string | null) => {
    lastFolderConfigPath = folderPath;
    if (folderConfigStatus === 'loading') {
      return { state: { status: 'loading' }, refresh: () => {} };
    }
    return {
      state: {
        status: 'ready',
        data: { folder: { templates_available: folderTemplates } },
      },
      refresh: () => {},
    };
  },
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

function renderFileTree() {
  return render(<FileTree />);
}

describe('FileTree startCreating addPage symmetry', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    model = new StubModel();
    menuItem = { kind: 'directory', path: 'notes/' };
    closeMenuMock = vi.fn(() => {});
    createResponse = {
      docName: 'notes/Untitled',
      path: 'notes/Untitled.md',
    };
    createStatus = 200;
    createGate = null;
    createFetchError = null;
    deletePathStatus = 200;
    deletePathResponse = { ok: true };
    deletePathFetchError = null;
    folderTemplates = [];
    folderConfigStatus = 'ready';
    lastFolderConfigPath = null;
    fetchCalls = [];
    globalThis.fetch = makeFetchMock() as unknown as typeof fetch;
    toastSuccessMock.mockClear();
    toastErrorMock.mockClear();
    addPageMock.mockClear();
    openTargetMock.mockClear();
    notifySidebarFileSelectedMock.mockClear();
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  test('folder context-menu New File registers the created docName via addPage exactly once', async () => {
    const user = userEvent.setup();
    renderFileTree();

    const newFile = await screen.findByRole('menuitem', { name: /new file/i });
    fetchCalls = [];
    await user.click(newFile);

    await waitFor(() => expect(createPageCalls()).toHaveLength(1));
    const [call] = createPageCalls();
    expect(call?.url).toBe('/api/create-page');
    expect(call?.init?.method).toBe('POST');
    await waitFor(() => expect(addPageMock).toHaveBeenCalledWith('notes/Untitled'));
    expect(addPageMock).toHaveBeenCalledTimes(1);
  });

  test('folder context-menu New Folder does NOT register an addPage call', async () => {
    createResponse = {
      kind: 'folder',
      path: 'notes/SubDir',
    };
    const user = userEvent.setup();
    renderFileTree();

    const newFolder = await screen.findByRole('menuitem', { name: /new folder/i });
    fetchCalls = [];
    await user.click(newFolder);

    await waitFor(() => expect(fetchCalls.some((c) => c.url === '/api/create-folder')).toBe(true));
    expect(addPageMock).not.toHaveBeenCalled();
  });

  test('folder context-menu hides "New from template" when the folder has no templates', async () => {
    folderTemplates = [];
    renderFileTree();

    expect(await screen.findByRole('menuitem', { name: /new file/i })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: /new from template/i })).toBeNull();
  });

  test('folder context-menu shows "New from template" when the folder has templates', async () => {
    folderTemplates = [
      {
        name: 'daily',
        title: 'Daily',
        path: 'notes/.ok/templates/daily.md',
        source_folder: 'notes',
        scope: 'local',
      },
    ];
    renderFileTree();

    expect(await screen.findByRole('menuitem', { name: /new from template/i })).toBeTruthy();
    expect(lastFolderConfigPath).toBe('notes');
  });

  test('folder context-menu keeps "New from template" while folder config is loading', async () => {
    folderConfigStatus = 'loading';
    folderTemplates = [];
    renderFileTree();

    expect(await screen.findByRole('menuitem', { name: /new from template/i })).toBeTruthy();
  });

  describe('pending-create cleanup intent', () => {
    async function startPendingFileCreate(user: ReturnType<typeof userEvent.setup>) {
      const newFile = await screen.findByRole('menuitem', { name: /new file/i });
      fetchCalls = [];
      await user.click(newFile);
      await waitFor(() => expect(createPageCalls()).toHaveLength(1));
      await waitFor(() => expect(model.startRenaming).toHaveBeenCalled());
      return model.startRenaming.mock.calls.at(-1)?.[0] as string;
    }

    async function startPendingFolderCreate(user: ReturnType<typeof userEvent.setup>) {
      const newFolder = await screen.findByRole('menuitem', { name: /new folder/i });
      fetchCalls = [];
      await user.click(newFolder);
      await waitFor(() =>
        expect(fetchCalls.some((call) => call.url === '/api/create-folder')).toBe(true),
      );
      await waitFor(() => expect(model.startRenaming).toHaveBeenCalled());
      return model.startRenaming.mock.calls.at(-1)?.[0] as string;
    }

    test('an unmount with a pending create does not hard-delete the created file', async () => {
      const user = userEvent.setup();
      const view = renderFileTree();
      await startPendingFileCreate(user);

      view.unmount();

      expect(deletePathCalls()).toHaveLength(0);
    });

    test('cancelling the inline rename still hard-deletes the placeholder', async () => {
      const user = userEvent.setup();
      renderFileTree();
      const renamePath = await startPendingFileCreate(user);

      act(() => model.emitRemove(renamePath));

      await waitFor(() => expect(deletePathCalls()).toHaveLength(1));
      const [call] = deletePathCalls();
      expect(call?.init?.method).toBe('POST');
      expect(JSON.parse(String(call?.init?.body))).toEqual({
        kind: 'file',
        path: 'notes/Untitled',
      });
    });

    test('cancelling the inline rename closes the placeholder tab and returns to the previous location', async () => {
      const user = userEvent.setup();
      window.location.hash = '#/notes/somewhere-else';
      renderFileTree();
      const renamePath = await startPendingFileCreate(user);
      closeDocumentMock.mockClear();

      act(() => model.emitRemove(renamePath));

      await waitFor(() => expect(closeDocumentMock).toHaveBeenCalledWith('notes/Untitled'));
      await waitFor(() => expect(window.location.hash).toBe('#/notes/somewhere-else'));
    });

    test('a failed discard cleanup reports through console.error and still toasts', async () => {
      const user = userEvent.setup();
      renderFileTree();
      const renamePath = await startPendingFileCreate(user);

      deletePathStatus = 500;
      deletePathResponse = { title: 'disk is full' };

      act(() => model.emitRemove(renamePath));

      await waitFor(() => expect(deletePathCalls()).toHaveLength(1));
      await waitFor(() =>
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ kind: 'file', path: 'notes/Untitled' }),
        ),
      );
      expect(toastErrorMock).toHaveBeenCalled();
    });

    test('cancelling a folder create closes the folder tab, not a document tab', async () => {
      createResponse = { kind: 'folder', path: 'notes/SubDir' };
      const user = userEvent.setup();
      renderFileTree();
      const renamePath = await startPendingFolderCreate(user);
      closeTabsMock.mockClear();
      closeDocumentMock.mockClear();

      act(() => model.emitRemove(renamePath));

      await waitFor(() => expect(deletePathCalls()).toHaveLength(1));
      expect(JSON.parse(String(deletePathCalls()[0]?.init?.body))).toEqual({
        kind: 'folder',
        path: 'notes/SubDir',
      });
      expect(closeTabsMock).toHaveBeenCalledWith([folderTabId('notes/SubDir')], { force: true });
      expect(closeDocumentMock).not.toHaveBeenCalled();
    });

    test('a discard whose delete request throws reports the network error and still toasts', async () => {
      const user = userEvent.setup();
      renderFileTree();
      const renamePath = await startPendingFileCreate(user);

      deletePathFetchError = new Error('network down');

      act(() => model.emitRemove(renamePath));

      await waitFor(() => expect(deletePathCalls()).toHaveLength(1));
      await waitFor(() =>
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            kind: 'file',
            path: 'notes/Untitled',
            cause: expect.objectContaining({ message: 'network down' }),
          }),
        ),
      );
      expect(toastErrorMock).toHaveBeenCalled();
    });

    test('remounting after a crash-path unmount keeps the file and starts no new rename', async () => {
      const user = userEvent.setup();
      const view = renderFileTree();
      await startPendingFileCreate(user);
      const renameCallsAfterCreate = model.startRenaming.mock.calls.length;

      view.unmount();
      const remounted = renderFileTree();

      expect(await remounted.findByTestId('fake-pierre-tree')).toBeTruthy();
      expect(model.startRenaming.mock.calls.length).toBe(renameCallsAfterCreate);
      expect(deletePathCalls()).toHaveLength(0);
      expect(toastErrorMock).not.toHaveBeenCalled();
    });
  });
});
