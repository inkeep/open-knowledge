/**
 * Sidebar truncation affordance for the sidebar's disk-walk listing.
 *
 * The integration test stops at the HTTP boundary; nothing exercised the
 * FileTree render path that consumes `truncated`. This drives the real
 * component (testing-library + jsdom) with a mocked
 * depth-1 root-seed response, asserting the `role="status"` notice
 * renders ONLY when truncated, renders as a contained alert row (icon + muted
 * rounded box) with a locale-formatted count and guidance that makes no
 * search claim (disk-walk-only files are absent from the search index), is a
 * polite non-interactive live region, and stays absent when the list is
 * complete. The sibling `role="alert"` error row
 * gets the same container treatment with a destructive tone.
 *
 * A live-browser path (`bun run dev` + Playwright) is not used: it requires
 * binding a dev-server socket, which the harness sandbox denies — the DOM
 * test is the durable, higher-signal substitute.
 *
 * `@pierre/trees/react`'s FileTree is mocked to render the `header` prop (where
 * the notice lives); the create/duplicate `.dom.test` precedents mock it to
 * render only `renderContextMenu`, which would hide the surface under test.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { i18n } from '@lingui/core';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';

// The component formats the truncation count with `Intl.NumberFormat` keyed
// off `useLingui().i18n.locale`; the macro test shim hands back this real
// singleton, so activate `en` (as `src/lib/i18n.ts` does in production) for
// deterministic "1,200"-style output regardless of the host machine's locale.
i18n.load('en', {});
i18n.activate('en');

function PassThrough({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

// URL the Show All docs fetch requests: the lazy depth-1 root seed, not the
// full recursive walk.
const SHOW_ALL_DEPTH1_URL = '/api/documents?showAll=true&dir=&depth=1';

// --- mutable per-test state ---
// The sidebar always issues the disk-walk listing; these tests exercise that
// default path. Config only carries `showHiddenFiles` now.
let mergedConfig: unknown = { appearance: { sidebar: {} } };
// Body returned for the Show All request.
let showAllBody: unknown = { documents: [], truncated: true };
// HTTP status the Show All mock returns. Mutable so tests can swap a
// later fetch to 5xx and pin the state transition that clears a stale notice.
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
    // Any other endpoint the mount touches (delete/rename cleanup, etc.).
    return jsonResponse({ ok: true });
  });
}

// --- module mocks (mirrors the FileTree.create/.duplicate dom-test set so the
// component mounts; only config-provider + @pierre/trees/react diverge). ---

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
  // RENDER the header — that is the surface under test.
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
    // N = the RAW server-returned (cap-bounded) document count. Under lazy
    // depth-1 loading the cap applies per level, so the copy scopes the count
    // to the truncated folder rather than claiming a whole-tree total.
    expect(text).toContain('Showing the first 3 items in one folder');
    expect(text).toContain('the rest of that folder is hidden');
    // Search cannot find the truncated items (disk-walk-only files are not in
    // the index-backed search corpus) — pin that the copy makes no such claim.
    expect(text.toLowerCase()).not.toContain('search');
    // Contained alert-row treatment: rounded muted box + decorative icon,
    // not the bare text span this replaced.
    expect(status.className).toContain('rounded-md');
    expect(status.className).toContain('bg-muted/50');
    const icon = status.querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    // The error header (role=alert) is a sibling — only the status one renders.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('locale-formats the truncation count (1,200 — not a raw 1200)', async () => {
    showAllBody = {
      documents: Array.from({ length: 1200 }, (_, i) => docEntry(`dir/file-${i}`)),
      truncated: true,
    };
    render(<FileTree />);

    // waitFor (not findByRole) so a poll that lands while the loading
    // skeleton's own role=status is mounted just retries.
    await waitFor(() => {
      expect(screen.getByRole('status').textContent ?? '').toContain('1,200');
    });
    expect(screen.getByRole('status').textContent ?? '').not.toContain('1200');
  });

  test('does NOT render the notice when the showAll response is not truncated (QA-002 negative)', async () => {
    showAllBody = { documents: [docEntry('a'), docEntry('b')], truncated: false };
    render(<FileTree />);

    // The tree host renders only after the docs fetch resolves (loading=false),
    // so its presence proves the response was processed — making the absence
    // assertion meaningful rather than a pre-fetch vacuous pass.
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
    // role=status is an implicit aria-live=polite region (not assertive).
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).not.toBe('assertive');
    // Non-interactive: no focusable/interactive descendants to navigate.
    expect(within(status).queryByRole('button')).toBeNull();
    expect(within(status).queryByRole('link')).toBeNull();
    expect(within(status).queryByRole('textbox')).toBeNull();
  });

  test('a subsequent server-error response clears a previously-displayed truncation notice', async () => {
    // Pins the state-transition: if a later fetch fails with a non-2xx, the
    // production code clears the notice — otherwise users see a stale
    // "Showing first N items" line above a fresh error, which contradicts
    // itself. Without this test, a refactor that drops the
    // `setTruncatedShownCount(null)` on the error branch passes the existing
    // truncated-vs-not-truncated coverage but ships the contradiction.
    showAllBody = { documents: [docEntry('a'), docEntry('b'), docEntry('c')], truncated: true };
    render(<FileTree />);
    await waitFor(() =>
      expect(screen.getByRole('status').textContent ?? '').toContain('Showing the first'),
    );

    // Swap the next fetch to a 5xx with an error body; dispatching `focus`
    // routes through the same `createRefreshScheduler` request path
    // (`window.addEventListener('focus', handleResume)` in FileTree).
    showAllBody = { title: 'Internal server error' };
    showAllStatus = 500;
    window.dispatchEvent(new Event('focus'));

    // The notice must disappear once the second fetch settles.
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    // And the alert appears in its place — proves the second response was
    // actually consumed (otherwise the wait could time-out on a vacuous DOM).
    const alert = screen.getByRole('alert');
    expect(alert.textContent ?? '').toContain('Internal server error');
    // Same contained row treatment as the status notice, destructive tone +
    // warning icon (color is never the sole channel).
    expect(alert.className).toContain('rounded-md');
    expect(alert.className).toContain('bg-muted/50');
    expect(alert.className).toContain('text-destructive');
    const alertIcon = alert.querySelector('svg');
    expect(alertIcon).not.toBeNull();
    expect(alertIcon?.getAttribute('aria-hidden')).toBe('true');
  });
});
