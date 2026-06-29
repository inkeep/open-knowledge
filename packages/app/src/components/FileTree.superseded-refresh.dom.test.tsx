import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

function PassThrough({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

let mergedConfig: unknown = null;
const documentsFetchPlan: Array<
  (signal: AbortSignal | null | undefined) => Response | Promise<Response>
> = [];
let documentsCallCount = 0;
let resolveTrailingDocuments: ((body: unknown) => void) | null = null;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function abortableBodyResponse(signal: AbortSignal | null | undefined): Response {
  const stream = new ReadableStream({
    start(controller) {
      const failWithAbort = () =>
        controller.error(new DOMException('The operation was aborted.', 'AbortError'));
      if (!signal) return;
      if (signal.aborted) failWithAbort();
      else signal.addEventListener('abort', failWithAbort, { once: true });
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function deferredDocumentsResponse(): Promise<Response> {
  return new Promise((resolve) => {
    resolveTrailingDocuments = (body: unknown) => resolve(jsonResponse(body));
  });
}

function docEntry(docName: string) {
  return {
    kind: 'document',
    docName,
    docExt: '.md',
    size: 1,
    modified: '2026-05-18T00:00:00.000Z',
  };
}

function makeFetchMock() {
  return mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('/api/documents')) {
      documentsCallCount += 1;
      const next = documentsFetchPlan.shift();
      if (next) return next(init?.signal);
      return jsonResponse({ documents: [docEntry('notes/fallback')] });
    }
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
    for (const path of paths) this.items.set(path, new StubItem(path, path.endsWith('/')));
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

describe('FileTree superseded documents refresh', () => {
  let consoleWarnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    model = new StubModel();
    mergedConfig = null;
    documentsFetchPlan.length = 0;
    documentsCallCount = 0;
    resolveTrailingDocuments = null;
    globalThis.fetch = makeFetchMock() as unknown as typeof fetch;
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleWarnSpy.mockRestore();
  });

  test('initial load: superseding the in-flight refresh keeps the skeleton — no terminal shape error', async () => {
    documentsFetchPlan.push(
      (signal) => abortableBodyResponse(signal),
      () => deferredDocumentsResponse(),
    );
    render(<FileTree />);

    await waitFor(() => expect(documentsCallCount).toBe(1));
    expect(screen.getByRole('status', { name: /loading files/i })).toBeTruthy();

    window.dispatchEvent(new Event('focus'));

    await waitFor(() => expect(documentsCallCount).toBe(2));

    expect(screen.queryByText(/did not match expected shape/i)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/no files yet/i)).toBeNull();
    expect(screen.getByRole('status', { name: /loading files/i })).toBeTruthy();

    resolveTrailingDocuments?.({ documents: [docEntry('notes/a')] });
    await screen.findByTestId('fake-pierre-tree');
    expect(screen.queryByText(/did not match expected shape/i)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();

    const fetchFailedWarns = consoleWarnSpy.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('[FileTree] fetch failed:'),
    );
    expect(fetchFailedWarns).toEqual([]);
  });

  test('after a successful load: a superseded refresh keeps the previous tree — no alert banner', async () => {
    documentsFetchPlan.push(
      () => jsonResponse({ documents: [docEntry('notes/a')] }),
      (signal) => abortableBodyResponse(signal),
      () => deferredDocumentsResponse(),
    );
    render(<FileTree />);
    await screen.findByTestId('fake-pierre-tree');

    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(documentsCallCount).toBe(2));

    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(documentsCallCount).toBe(3));

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/did not match expected shape/i)).toBeNull();
    expect(screen.getByTestId('fake-pierre-tree')).toBeTruthy();

    resolveTrailingDocuments?.({ documents: [docEntry('notes/a'), docEntry('notes/b')] });
    await waitFor(() => {
      expect(screen.getByTestId('fake-pierre-tree')).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    const fetchFailedWarns = consoleWarnSpy.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('[FileTree] fetch failed:'),
    );
    expect(fetchFailedWarns).toEqual([]);
  });
});
