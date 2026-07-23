import { cleanup, render } from '@testing-library/react';
import type { MouseEventHandler, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type DocumentsChangedListener = (channels: string[]) => void;
type TemplatesChangedListener = () => void;

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
    <button type="button" role="menuitem" disabled={disabled} onClick={onSelect} {...props}>
      {children}
    </button>
  );
}

class StubModel {
  private readonly items = new Map<string, { isExpanded: () => boolean }>();

  getFocusedPath() {
    return null;
  }

  getFocusedIndex() {
    return -1;
  }

  getItemHeight() {
    return 24;
  }

  getSelectedPaths() {
    return [];
  }

  getItem(path: string) {
    return this.items.get(path) ?? null;
  }

  resetPaths(paths: string[]) {
    this.items.clear();
    for (const path of paths) {
      this.items.set(path, { isExpanded: () => false });
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

  add() {}
  move() {}
  remove() {}
  focus() {}
}

let model = new StubModel();
let documentsChangedListener: DocumentsChangedListener | null = null;
let templatesChangedListener: TemplatesChangedListener | null = null;
let unsubscribeDocumentsChangedMock = vi.fn(() => {});
let unsubscribeTemplatesChangedMock = vi.fn(() => {});
let schedulerRequestMock = vi.fn(() => {});
let schedulerDisposeMock = vi.fn(() => {});
const createRefreshSchedulerMock = vi.fn(() => ({
  request: schedulerRequestMock,
  dispose: schedulerDisposeMock,
}));
const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === '/api/workspace') {
    return new Response(
      JSON.stringify({
        contentDir: '/tmp/open-knowledge',
        pathSeparator: '/',
        symlinkResolved: true,
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  }
  throw new Error(`unexpected fetch: ${url}`);
});

vi.doMock('sonner', () => ({
  toast: {
    success: () => {},
    error: () => {},
  },
}));

vi.doMock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    activeDocName: 'notes/source',
    activeTarget: { kind: 'doc', target: 'notes/source', docName: 'notes/source' },
    closeTabs: () => {},
    closeDocument: () => {},
    closeAndClearForRename: async () => {},
    getPoolActiveDocName: () => 'notes/source',
    isNewTabActive: false,
    openTarget: () => {},
    prewarm: () => {},
    remapTabsForRename: () => {},
  }),
}));

vi.doMock('@/components/PageListContext', () => ({
  usePageList: () => ({ addPage: () => {} }),
}));

vi.doMock('./ui/sidebar', () => ({
  useSidebar: () => ({ notifySidebarFileSelected: () => {} }),
}));

vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    okignoreBinding: null,
    projectLocalBinding: null,
    merged: null,
  }),
}));

vi.doMock('@/hooks/use-conflicts', () => ({
  useConflicts: () => ({ conflicts: [], loading: false, error: null }),
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
  DropdownMenuContent: ({ children }: { children?: ReactNode }) => (
    <div role="menu">{children}</div>
  ),
  DropdownMenuItem: MenuItem,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuSub: PassThrough,
  DropdownMenuSubContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
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
  asDirectoryHandle: () => null,
  useSelectionMirror: () => {},
}));

vi.doMock('@pierre/trees', () => ({
  FILE_TREE_TAG_NAME: 'ok-file-tree',
  themeToTreeStyles: () => ({}),
}));

vi.doMock('@pierre/trees/react', () => ({
  useFileTree: () => ({ model }),
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

vi.doMock('@/lib/documents-events', () => ({
  emitDocumentsChanged: () => {},
  emitTemplatesChanged: () => {},
  subscribeToDocumentsChanged: (listener: DocumentsChangedListener) => {
    documentsChangedListener = listener;
    return () => {
      if (documentsChangedListener === listener) {
        documentsChangedListener = null;
      }
      unsubscribeDocumentsChangedMock();
    };
  },
  subscribeToTemplatesChanged: (listener: TemplatesChangedListener) => {
    templatesChangedListener = listener;
    return () => {
      if (templatesChangedListener === listener) {
        templatesChangedListener = null;
      }
      unsubscribeTemplatesChangedMock();
    };
  },
}));

vi.doMock('@/lib/refresh-scheduler', () => ({
  createRefreshScheduler: createRefreshSchedulerMock,
}));

const { FileTree } = await import('./FileTree');

describe('FileTree document-list refresh scheduling', () => {
  let setIntervalSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    model = new StubModel();
    documentsChangedListener = null;
    templatesChangedListener = null;
    unsubscribeDocumentsChangedMock = vi.fn(() => {});
    unsubscribeTemplatesChangedMock = vi.fn(() => {});
    schedulerRequestMock = vi.fn(() => {});
    schedulerDisposeMock = vi.fn(() => {});
    createRefreshSchedulerMock.mockClear();
    fetchMock.mockClear();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    setIntervalSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  test('routes mount, focus, and files-channel refreshes through the bounded scheduler', () => {
    const { unmount } = render(<FileTree />);

    expect(createRefreshSchedulerMock).toHaveBeenCalledTimes(1);
    expect(schedulerRequestMock).toHaveBeenCalledTimes(1);
    expect(documentsChangedListener).not.toBeNull();
    expect(setIntervalSpy).not.toHaveBeenCalled();

    window.dispatchEvent(new Event('focus'));
    expect(schedulerRequestMock).toHaveBeenCalledTimes(2);

    documentsChangedListener?.(['backlinks']);
    expect(schedulerRequestMock).toHaveBeenCalledTimes(2);

    documentsChangedListener?.(['files']);
    expect(schedulerRequestMock).toHaveBeenCalledTimes(3);
    expect(setIntervalSpy).not.toHaveBeenCalled();

    unmount();

    expect(schedulerDisposeMock).toHaveBeenCalledTimes(1);
    expect(unsubscribeDocumentsChangedMock).toHaveBeenCalledTimes(1);
    expect(documentsChangedListener).toBeNull();
  });
});
