import { i18n } from '@lingui/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MouseEventHandler, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

i18n.load('en', {});
i18n.activate('en');

function PassThrough({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

const DOCUMENTS = [
  {
    kind: 'document',
    docName: 'note',
    docExt: '.md',
    size: 1,
    modified: '2026-07-28T00:00:00.000Z',
  },
  {
    kind: 'folder',
    path: 'docs',
    size: 0,
    modified: '2026-07-28T00:00:00.000Z',
    hasChildren: true,
  },
];

let previewTabsEnabled = true;
const openTargetMock = vi.fn(() => {});
const notifySidebarFileSelectedMock = vi.fn(() => {});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeFetchMock() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('/api/documents')) {
      return jsonResponse({ documents: DOCUMENTS, truncated: false });
    }
    if (url === '/api/workspace') {
      return jsonResponse({
        contentDir: '/tmp/open-knowledge',
        pathSeparator: '/',
        symlinkResolved: true,
      });
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

const model = new StubModel();

vi.doMock('sonner', () => ({
  toast: { success: vi.fn(() => {}), error: vi.fn(() => {}) },
}));
vi.doMock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));
vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    activeDocName: null,
    activeTarget: null,
    closeTabs: vi.fn(() => {}),
    closeDocument: vi.fn(() => {}),
    isNewTabActive: false,
    openTarget: openTargetMock,
    prewarm: () => {},
    reconcileLocalRemoval: vi.fn(async () => {}),
    reconcileLocalRename: vi.fn(async () => {}),
    setSkillsSidebar: vi.fn(() => {}),
  }),
}));
vi.doMock('@/components/PageListContext', () => ({
  usePageList: () => ({
    addPage: vi.fn(() => {}),
    pageMeta: new Map(),
    pages: new Set<string>(),
  }),
}));
vi.doMock('./ui/sidebar', () => ({
  useSidebar: () => ({ notifySidebarFileSelected: notifySidebarFileSelectedMock }),
}));
vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    okignoreBinding: null,
    projectLocalBinding: null,
    merged: {
      appearance: { sidebar: {} },
      editor: { previewTabs: previewTabsEnabled },
    },
  }),
}));
vi.doMock('./handoff/useInstalledAgents', () => ({
  useInstalledAgents: () => ({ states: {} }),
}));
vi.doMock('./handoff/useHandoffDispatch', () => ({
  buildFolderHandoffInput: () => null,
  buildHandoffInput: () => null,
  useHandoffDispatch: () => ({ dispatch: vi.fn(async () => ({ ok: true as const })) }),
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
vi.doMock('@/components/ui/dialog', () => ({ Dialog: PassThrough }));
vi.doMock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: PassThrough,
  DropdownMenuContent: PassThrough,
  DropdownMenuItem: PassThrough,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuSub: PassThrough,
  DropdownMenuSubContent: PassThrough,
  DropdownMenuSubTrigger: PassThrough,
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
  FileTree: ({ onClickCapture }: { onClickCapture?: MouseEventHandler<HTMLDivElement> }) => (
    <div data-testid="fake-pierre-tree" role="tree" onClickCapture={onClickCapture}>
      <div
        role="treeitem"
        data-item-path="note.md"
        data-item-type="file"
        aria-selected="false"
        tabIndex={-1}
      >
        note.md
      </div>
      <div
        role="treeitem"
        data-item-path="docs/"
        data-item-type="folder"
        aria-selected="false"
        tabIndex={-1}
      >
        docs/
      </div>
      {/* Pierre's pinned folder header: same row, no role and no aria-selected. */}
      <div
        data-testid="sticky-docs"
        data-item-path="docs/"
        data-item-type="folder"
        data-file-tree-sticky-row="true"
        data-file-tree-sticky-path="docs/"
        tabIndex={-1}
      >
        docs/
      </div>
    </div>
  ),
}));

const { FileTree } = await import('./FileTree');

describe('FileTree preview-tab activation', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    previewTabsEnabled = true;
    model.items.clear();
    model.selectedPaths = [];
    openTargetMock.mockClear();
    notifySidebarFileSelectedMock.mockClear();
    window.location.hash = '';
    globalThis.fetch = makeFetchMock() as unknown as typeof fetch;
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleWarnSpy.mockRestore();
  });

  test.each([
    ['enabled', true, 'preview'],
    ['disabled', false, 'permanent'],
  ] as const)('opens document and folder rows as %s tabs without dropping hash or selection notifications', async (_state, enabled, disposition) => {
    previewTabsEnabled = enabled;
    render(<FileTree />);

    await screen.findByTestId('fake-pierre-tree');
    await waitFor(() => expect(model.getItem('docs/')).not.toBeNull());

    fireEvent.click(screen.getByRole('treeitem', { name: 'note.md' }));

    await waitFor(() =>
      expect(openTargetMock).toHaveBeenNthCalledWith(
        1,
        { kind: 'doc', target: 'note', docName: 'note' },
        { disposition, consumeActiveNewTab: true },
      ),
    );
    expect(window.location.hash).toBe('#/note');
    expect(notifySidebarFileSelectedMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('treeitem', { name: 'docs/' }));

    await waitFor(() =>
      expect(openTargetMock).toHaveBeenNthCalledWith(
        2,
        { kind: 'folder', target: 'docs', folderPath: 'docs' },
        { disposition, consumeActiveNewTab: true },
      ),
    );
    expect(window.location.hash).toBe('#/docs/');
    expect(notifySidebarFileSelectedMock).toHaveBeenCalledTimes(2);
  });

  test('leaves a click on a pinned folder header to the tree, so it collapses instead of reopening', async () => {
    render(<FileTree />);

    await screen.findByTestId('fake-pierre-tree');
    await waitFor(() => expect(model.getItem('docs/')).not.toBeNull());

    fireEvent.click(screen.getByTestId('sticky-docs'));

    // The pre-fix path reached navigation through `queueMicrotask`, so one
    // flush is all it takes to catch it. A `waitFor` would pass on its first
    // synchronous check and prove nothing.
    await Promise.resolve();
    expect(openTargetMock).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('');
  });
});
