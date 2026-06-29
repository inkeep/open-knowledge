import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { i18n } from '@lingui/core';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';

i18n.load('en', {});
i18n.activate('en');

function PassThrough({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

const SHOW_ALL_DEPTH1_URL = '/api/documents?showAll=true&dir=&depth=1';

let mergedConfig: unknown = { appearance: { sidebar: {} } };
let showAllBody: unknown = { documents: [], truncated: true };
let showAllStatus = 200;
const fetchUrls: string[] = [];

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
    modified: '2026-05-18T00:00:00.000Z',
  };
}

function makeFetchMock() {
  return mock(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    fetchUrls.push(url);
    if (url === SHOW_ALL_DEPTH1_URL) return jsonResponse(showAllBody, showAllStatus);
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

describe('FileTree showAll truncation notice', () => {
  let consoleWarnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mergedConfig = { appearance: { sidebar: {} } };
    showAllBody = { documents: [], truncated: true };
    showAllStatus = 200;
    fetchUrls.length = 0;
    globalThis.fetch = makeFetchMock() as unknown as typeof fetch;
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleWarnSpy.mockRestore();
  });

  test('renders the truncation notice as a contained, iconed status row with truthful copy (QA-001/QA-002)', async () => {
    showAllBody = {
      documents: [docEntry('a'), docEntry('b'), docEntry('c')],
      truncated: true,
    };
    render(<FileTree />);

    await waitFor(() => expect(fetchUrls).toContain(SHOW_ALL_DEPTH1_URL));
    const status = await screen.findByRole('status');
    const text = status.textContent ?? '';
    expect(text).toContain('Showing the first 3 items in one folder');
    expect(text).toContain('the rest of that folder is hidden');
    expect(text.toLowerCase()).not.toContain('search');
    expect(status.className).toContain('rounded-md');
    expect(status.className).toContain('bg-muted/50');
    const icon = status.querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('locale-formats the truncation count (1,200 — not a raw 1200)', async () => {
    showAllBody = {
      documents: Array.from({ length: 1200 }, (_, i) => docEntry(`dir/file-${i}`)),
      truncated: true,
    };
    render(<FileTree />);

    await waitFor(() => {
      expect(screen.getByRole('status').textContent ?? '').toContain('1,200');
    });
    expect(screen.getByRole('status').textContent ?? '').not.toContain('1200');
  });

  test('does NOT render the notice when the showAll response is not truncated (QA-002 negative)', async () => {
    showAllBody = { documents: [docEntry('a'), docEntry('b')], truncated: false };
    render(<FileTree />);

    await screen.findByTestId('fake-pierre-tree');
    expect(fetchUrls).toContain(SHOW_ALL_DEPTH1_URL);
    expect(screen.queryByRole('status')).toBeNull();
  });

  test('does NOT render the notice when truncated is absent from the showAll response (QA-002 negative)', async () => {
    showAllBody = { documents: [docEntry('a')] };
    render(<FileTree />);

    await screen.findByTestId('fake-pierre-tree');
    expect(fetchUrls).toContain(SHOW_ALL_DEPTH1_URL);
    expect(screen.queryByRole('status')).toBeNull();
  });

  test('the truncation notice is a polite, non-interactive live region (QA-004 a11y)', async () => {
    showAllBody = { documents: [docEntry('a'), docEntry('b')], truncated: true };
    render(<FileTree />);

    const status = await screen.findByRole('status');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).not.toBe('assertive');
    expect(within(status).queryByRole('button')).toBeNull();
    expect(within(status).queryByRole('link')).toBeNull();
    expect(within(status).queryByRole('textbox')).toBeNull();
  });

  test('a subsequent server-error response clears a previously-displayed truncation notice', async () => {
    showAllBody = { documents: [docEntry('a'), docEntry('b'), docEntry('c')], truncated: true };
    render(<FileTree />);
    await waitFor(() =>
      expect(screen.getByRole('status').textContent ?? '').toContain('Showing the first'),
    );

    showAllBody = { title: 'Internal server error' };
    showAllStatus = 500;
    window.dispatchEvent(new Event('focus'));

    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    const alert = screen.getByRole('alert');
    expect(alert.textContent ?? '').toContain('Internal server error');
    expect(alert.className).toContain('rounded-md');
    expect(alert.className).toContain('bg-muted/50');
    expect(alert.className).toContain('text-destructive');
    const alertIcon = alert.querySelector('svg');
    expect(alertIcon).not.toBeNull();
    expect(alertIcon?.getAttribute('aria-hidden')).toBe('true');
  });
});
