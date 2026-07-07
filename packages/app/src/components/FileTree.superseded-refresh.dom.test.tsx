/**
 * Superseded documents-refresh contract: a refresh that is
 * superseded (aborted) after the 200 headers arrive but before the body is
 * fully read must NOT publish UI state — no terminal "Documents response did
 * not match expected shape." error, and the loading skeleton / previous tree
 * stays until a non-superseded refresh definitively completes.
 *
 * Production failure mode (reproduced in real Chromium against the real
 * server): during a long initial load the server's warmup CC1 `files` nudge —
 * or a user refocusing the window — fires `scheduler.request()` while the
 * first `/api/documents` fetch is mid-body-read; the scheduler aborts the
 * in-flight run, `res.json()` rejects with an AbortError, and the laundered
 * `{ok: true, body: null}` paints the terminal shape error over the skeleton.
 *
 * Bun's fetch buffers bodies eagerly, so the race cannot be produced through
 * a real fetch here: the mocked `/api/documents` returns a Response over a
 * ReadableStream that errors with an AbortError when the request's signal
 * aborts — the exact rejection Chromium's streaming fetch produces.
 *
 * Harness mirrors `FileTree.showall-truncation.dom.test.tsx` (mount the real
 * FileTree; mock `@pierre/trees/react` to render the `header` prop so the
 * `role="alert"` banner surface is observable).
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

function PassThrough({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

// --- mutable per-test state ---
// The mocked listing responds with buffered JSON (not NDJSON), so the docs
// refresh takes the buffered `parseServerResponse` branch — the bug path this
// suite pins — even though the client always requests the disk-walk listing.
let mergedConfig: unknown = null;
// Per-test queue of `/api/documents` responders, consumed in call order.
const documentsFetchPlan: Array<
  (signal: AbortSignal | null | undefined) => Response | Promise<Response>
> = [];
let documentsCallCount = 0;
// Resolver for the deferred trailing re-run response (set by
// `deferredDocumentsResponse`, fired by the test once it has asserted the
// superseded run published nothing).
let resolveTrailingDocuments: ((body: unknown) => void) | null = null;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A 200 whose body never arrives until the request's own AbortSignal fires,
 * at which point the body read rejects with a DOMException named
 * 'AbortError' — Chromium streaming-fetch semantics for an abort landing
 * after headers, mid-body-read.
 */
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

/**
 * An NDJSON 200 that emits one entry line immediately, then — like a real
 * streaming fetch — rejects the body read with an 'AbortError' when the
 * request's signal fires. Lets a test paint the first incremental batch, then
 * supersede the run mid-stream.
 */
function ndjsonFirstEntryThenAbort(
  signal: AbortSignal | null | undefined,
  firstLine: string,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(firstLine));
      const failWithAbort = () =>
        controller.error(new DOMException('The operation was aborted.', 'AbortError'));
      if (!signal) return;
      if (signal.aborted) failWithAbort();
      else signal.addEventListener('abort', failWithAbort, { once: true });
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
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
    // Any other endpoint the mount touches.
    return jsonResponse({ ok: true });
  });
}

// --- module mocks (mirrors the FileTree.showall-truncation dom-test set so
// the component mounts; @pierre/trees/react renders the header surface). ---

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
  // RENDER the header — the role=alert error banner lives there.
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
    // First refresh in flight (headers arrived, body pending) → skeleton.
    expect(screen.getByRole('status', { name: /loading files/i })).toBeTruthy();

    // Supersede the in-flight refresh — the same scheduler path a CC1
    // `files` nudge or a window refocus takes. The scheduler aborts run A's
    // controller mid-body-read.
    window.dispatchEvent(new Event('focus'));

    // Run A settles; the scheduler's trailing re-run issues fetch #2.
    await waitFor(() => expect(documentsCallCount).toBe(2));

    // The superseded run must not have published any UI state: no terminal
    // error, no flash of the empty state, skeleton still up.
    expect(screen.queryByText(/did not match expected shape/i)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/no files yet/i)).toBeNull();
    expect(screen.getByRole('status', { name: /loading files/i })).toBeTruthy();

    // Only the trailing (non-superseded) run drives the next UI state.
    resolveTrailingDocuments?.({ documents: [docEntry('notes/a')] });
    await screen.findByTestId('fake-pierre-tree');
    expect(screen.queryByText(/did not match expected shape/i)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();

    // The abort guard gates the console surface too: a superseded run is a
    // deliberate cancel, not a transport failure worth a per-supersede
    // `[FileTree] fetch failed:` warn. The spy record is append-only, so this
    // catches a leaked warn even where a later UI transition would mask the
    // point-in-time queries above. (`[FileTree] /api/workspace fetch failed:`
    // is a different prefix and stays out of the filter.)
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

    // Start refresh run 2 (nothing in flight → runs immediately).
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(documentsCallCount).toBe(2));

    // Supersede run 2 mid-body-read; the trailing run 3 follows.
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(documentsCallCount).toBe(3));

    // The superseded run must not have painted the header error banner or
    // torn down the previously-loaded tree.
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

  test('NDJSON: a superseded mid-stream refresh drops its batch; the fresh listing wins', async () => {
    // Exercises the incremental-paint abort guard: run 1 streams one entry
    // (the first batch paints additively), then a refocus supersedes it. The
    // scheduler aborts run 1 — its body read rejects with AbortError, so its
    // completion reconcile never runs — and run 2's authoritative splice prunes
    // the stale row the aborted stream painted.
    documentsFetchPlan.push(
      (signal) => ndjsonFirstEntryThenAbort(signal, `${JSON.stringify(docEntry('stale'))}\n`),
      () => jsonResponse({ documents: [docEntry('fresh')], truncated: false }),
    );
    render(<FileTree />);

    await waitFor(() => expect(documentsCallCount).toBe(1));
    await waitFor(() => expect([...model.items.keys()]).toEqual(['stale.md']));

    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(documentsCallCount).toBe(2));

    await waitFor(() => expect([...model.items.keys()]).toEqual(['fresh.md']));
    expect(model.items.has('stale.md')).toBe(false);

    // A superseded run is a deliberate cancel, not a fetch failure.
    const supersededWarns = consoleWarnSpy.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('[FileTree] fetch failed:'),
    );
    expect(supersededWarns).toEqual([]);
  });
});
