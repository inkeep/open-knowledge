/**
 * Pins the post-rename Pierre/React reconciliation contract — after
 * `applyRenamedDocuments` settles, `model.getFocusedPath()` and
 * `getSelectedPaths()` MUST hold the canonical with-extension path, not
 * an extensionless basename Pierre's `commitRename` can write to its store
 * when the user deletes the suffix before committing.
 *
 * `StubModel` mirrors Pierre's two relevant behaviors:
 *  - `move(source, dest)` remaps `focusedPath` and `selectedPaths`
 *    verbatim; throws `Source path does not exist` when source is missing
 *    (matches Pierre's `movePath`).
 *  - `resetPaths(paths)` falls back to `paths[0]` when the prior focused
 *    path is gone from the new set (Pierre's `resolveFocusedIndex` →
 *    index-0 fallback — the user-visible bug mechanism).
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { cleanup, render, waitFor } from '@testing-library/react';
import type { MouseEventHandler, ReactNode } from 'react';
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

// Three documents alphabetically. `foo.md` (index 1) is the rename target.
// After rename: ['aaa.md', 'bar.md', 'zzz.md']. The index-0 row (`aaa.md`)
// is the fallback target Pierre snaps focus onto when its `#focusedPath`
// diverges from the canonical paths — that's the user-visible symptom.
const INITIAL_DOCUMENTS: FileEntry[] = [
  {
    kind: 'document',
    docName: 'aaa',
    docExt: '.md',
    size: 1,
    modified: '2026-05-22T00:00:00.000Z',
  },
  {
    kind: 'document',
    docName: 'foo',
    docExt: '.md',
    size: 1,
    modified: '2026-05-22T00:00:00.000Z',
  },
  {
    kind: 'document',
    docName: 'zzz',
    docExt: '.md',
    size: 1,
    modified: '2026-05-22T00:00:00.000Z',
  },
];

interface FetchCall {
  url: string;
  init?: RequestInit;
}

class StubItem {
  expanded = false;
  selected = false;
  focusCount = 0;

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

  focus() {
    this.focusCount += 1;
  }
}

/**
 * Faithfully models Pierre's two relevant behaviors:
 *
 *   move(source, dest): remap focusedPath when it matches source. This is
 *     `#applyMutationState` + `remapMovedPath` behavior — Pierre stores
 *     whatever path move() was called with, without canonicalization.
 *
 *   resetPaths(paths): rebuild items; if previous focusedPath is no longer
 *     in the new path set, fall back to paths[0]. Models Pierre's
 *     `resolveFocusedIndex` final fallback branch.
 */
class StubModel {
  focusedPath: string | null = null;
  selectedPaths: string[] = [];
  items = new Map<string, StubItem>();
  startRenaming = mock(() => {});

  getFocusedPath() {
    return this.focusedPath;
  }

  getFocusedIndex() {
    if (this.focusedPath == null) return -1;
    const paths = Array.from(this.items.keys());
    return paths.indexOf(this.focusedPath);
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
    // Pierre's `resolveFocusedIndex` fallback: if the prior focusedPath
    // is not in the new path set, snap to index 0. This is the
    // load-bearing mechanism the bug exploits.
    if (this.focusedPath != null && !this.items.has(this.focusedPath)) {
      this.focusedPath = paths.length > 0 ? paths[0] : null;
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

  /**
   * Pierre's `#applyMutationState` remaps focusedPath verbatim — whatever
   * caller passed as `dest` becomes the new focusedPath. The extensionless
   * rename bug routes through here: caller is Pierre's commitRename, dest is
   * the suffix-less basename ('bar'), and focusedPath becomes 'bar'.
   *
   * Selection paths are remapped via the same `remapPathThroughMutation`
   * machinery on Pierre's side — modeled here so the test pins
   * `getSelectedPaths()` reconciliation as a side effect of `move()`.
   * Without this, a future refactor that swapped `model.move(basename,
   * canonical)` for `model.focusPath(canonical)` could pass the focus
   * assertion while silently regressing selection reconciliation.
   *
   * **Throws on missing source** — matches Pierre's `movePath`, which
   * raises `Source path does not exist: "<source>"`. Drag/drop and
   * folder-cascade tests rely on this to pin the
   * extensionless-rename reconciliation guard's correctness: if the guard
   * mistakenly calls `move()` on a path Pierre never had, the test fails
   * loudly here rather than silently no-op.
   */
  move(source: string, dest: string) {
    const item = this.items.get(source);
    if (item == null) {
      throw new Error(`Source path does not exist: "${source}"`);
    }
    if (this.focusedPath === source) {
      this.focusedPath = dest;
    }
    this.selectedPaths = this.selectedPaths.map((p) => (p === source ? dest : p));
    this.items.delete(source);
    this.items.set(dest, new StubItem(dest, item.isDirectory()));
  }

  remove(path: string) {
    this.items.delete(path);
    if (this.focusedPath === path) {
      this.focusedPath = null;
    }
  }

  /** Test helper — set initial focused path for the scenario setup. */
  focusPath(path: string) {
    this.focusedPath = path;
  }
}

let model = new StubModel();
let capturedOptions: unknown = null;
let documentsFetchResult: FileEntry[] = INITIAL_DOCUMENTS;
let renameResponseBody: unknown = {
  renamed: [{ fromDocName: 'foo', toDocName: 'bar' }],
  renamedAssets: [],
  rewrittenDocs: [],
};
let renameStatus = 200;
let fetchCalls: FetchCall[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeFetchMock() {
  return mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push({ url, init });
    if (url.startsWith('/api/documents')) {
      return jsonResponse({ documents: documentsFetchResult });
    }
    if (url === '/api/workspace') {
      return jsonResponse({
        contentDir: '/tmp/open-knowledge',
        pathSeparator: '/',
        symlinkResolved: true,
      });
    }
    if (url === '/api/rename-path') {
      return jsonResponse(renameResponseBody, renameStatus);
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
    activeDocName: 'foo',
    activeTarget: { kind: 'doc', target: 'foo', docName: 'foo' },
    closeTabs: closeTabsMock,
    closeDocument: closeDocumentMock,
    closeAndClearDocument: closeAndClearForRenameMock,
    closeAndClearForDelete: closeAndClearForRenameMock,
    closeAndClearForRename: closeAndClearForRenameMock,
    getPoolActiveDocName: () => 'foo',
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
    okignoreBinding: null,
    projectLocalBinding: null,
    merged: null,
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
  OpenInAgentContextSubmenu: () => null,
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
  useFileTree: (options: unknown) => {
    capturedOptions = options;
    return { model };
  },
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

const { FileTree } = await import('./FileTree');

interface RenameEvent {
  sourcePath: string;
  destinationPath: string;
  isFolder: boolean;
}

/**
 * Simulate Pierre's `#completeRenaming` ordering: fire the captured
 * `onRename(event)` callback (kicks off React's async handleTreeRename),
 * then mutate the model via `move(source, extensionlessDest)`. The move
 * remaps `model.focusedPath` from `'foo.md'` to `'bar'` (extensionless) —
 * the divergence the test pins.
 */
function simulatePierreCommitRename(
  source: string,
  extensionlessDest: string,
  isFolder: boolean,
): void {
  const options = capturedOptions as { renaming?: { onRename?: (e: RenameEvent) => void } } | null;
  const onRename = options?.renaming?.onRename;
  if (!onRename) {
    throw new Error('onRename callback missing from captured Pierre options');
  }
  onRename({ sourcePath: source, destinationPath: extensionlessDest, isFolder });
  model.move(source, extensionlessDest);
}

describe('FileTree post-rename Pierre/React store reconciliation', () => {
  let consoleWarnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    model = new StubModel();
    // Seed the stub with the initial visible paths so `getItem('foo.md')`
    // returns a real handle when pre-rename setup runs.
    model.resetPaths(['aaa.md', 'foo.md', 'zzz.md']);
    capturedOptions = null;
    documentsFetchResult = INITIAL_DOCUMENTS;
    renameResponseBody = {
      renamed: [{ fromDocName: 'foo', toDocName: 'bar' }],
      renamedAssets: [],
      rewrittenDocs: [],
    };
    renameStatus = 200;
    fetchCalls = [];
    globalThis.fetch = makeFetchMock() as unknown as typeof fetch;
    toastSuccessMock.mockClear();
    toastErrorMock.mockClear();
    addPageMock.mockClear();
    openTargetMock.mockClear();
    notifySidebarFileSelectedMock.mockClear();
    closeAndClearForRenameMock.mockClear();
    remapTabsForRenameMock.mockClear();
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleWarnSpy.mockRestore();
  });

  test('PRIMARY — after applyRenamedDocuments settles, model focusedPath is the canonical with-extension form', async () => {
    render(<FileTree />);

    // Wait for initial mount + useFileTree options capture.
    await waitFor(() => {
      expect(capturedOptions).not.toBeNull();
    });
    // Wait for FileTree's initial documents fetch + resetModelToDocuments
    // to settle. FileTree's mount overwrites the beforeEach seed; without
    // this wait, `model.move()` would throw "Source path does not exist".
    await waitFor(() => {
      expect(model.getItem('foo.md')).not.toBeNull();
    });

    // Seed pre-rename focus + selection on the row about to be renamed —
    // this is how Pierre's commitRename ends up remapping focusedPath +
    // selectedPaths from 'foo.md' to 'bar' (extensionless) on its
    // `move()` call. Selection is pinned in addition to focus so a future
    // refactor using `model.focusPath(canonical)` instead of
    // `model.move(basename, canonical)` cannot silently regress selection.
    model.focusPath('foo.md');
    model.selectedPaths = ['foo.md'];
    expect(model.getFocusedPath()).toBe('foo.md');
    expect(model.getSelectedPaths()).toEqual(['foo.md']);

    // Fire an extensionless rename: simulates Pierre's commitRename
    // ordering (onRename callback → move with extensionless dest).
    fetchCalls = [];
    simulatePierreCommitRename('foo.md', 'bar', false);

    // Wait directly on the observable outcome (Pierre's focusedPath
    // becoming canonical), not an intermediate proxy. addPage fires
    // BEFORE the setDocuments updater where reconciliation runs;
    // polling on focusedPath is resilient to React batching changes.
    await waitFor(() => {
      expect(model.getFocusedPath()).toBe('bar.md');
    });
    expect(model.getSelectedPaths()).toEqual(['bar.md']);
    expect(addPageMock).toHaveBeenCalledWith('bar');
  });

  test('SECONDARY — a forced post-rename resetPaths preserves focus on the renamed row (not the index-0 fallback)', async () => {
    render(<FileTree />);

    await waitFor(() => {
      expect(capturedOptions).not.toBeNull();
    });
    // Wait for FileTree's initial documents fetch + resetModelToDocuments
    // to settle before pre-seeding focus. The beforeEach seed is overwritten
    // by FileTree's initial mount; without this wait, `model.items` may be
    // empty in CI (slower scheduling) and `getFocusedIndex()` returns -1.
    await waitFor(() => {
      expect(model.getItem('foo.md')).not.toBeNull();
    });

    model.focusPath('foo.md');
    expect(model.getFocusedIndex()).toBe(1);

    simulatePierreCommitRename('foo.md', 'bar', false);

    // Wait directly on Pierre's focusedPath becoming canonical.
    await waitFor(() => {
      expect(model.getFocusedPath()).toBe('bar.md');
    });

    // Simulate any subsequent resetPaths trigger (file-watcher CC1
    // broadcast, refresh, late /api/documents re-fetch). Under the bug,
    // model.focusedPath is still 'bar' — not in the canonical paths — so
    // the stub's resolveFocusedIndex fallback snaps focus to index 0
    // ('aaa.md'), exactly as Pierre would. Under the fix, focus stays on
    // 'bar.md' at index 1.
    model.resetPaths(['aaa.md', 'bar.md', 'zzz.md']);

    expect(model.getFocusedPath()).toBe('bar.md');
    expect(model.getFocusedIndex()).toBe(1);
  });

  test('DRAG_DROP — Pierre store already canonical post-drop; reconciliation guard short-circuits without throwing', async () => {
    // Drag/drop semantic: Pierre's internal drop handler commits the move
    // with the CANONICAL tree path (no extensionless commit applies to drops). By the
    // time `applyRenamedDocuments` runs, Pierre's store no longer has the
    // extensionless basename — `getItem(toDocName)` returns null, so the
    // reconciliation guard MUST short-circuit. If the guard mistakenly
    // calls `model.move('subfolder/foo', 'subfolder/foo.md')`, the stub
    // (and real Pierre) throws "Source path does not exist".
    renameResponseBody = {
      renamed: [{ fromDocName: 'foo', toDocName: 'subfolder/foo' }],
      renamedAssets: [],
      rewrittenDocs: [],
    };

    render(<FileTree />);

    await waitFor(() => {
      expect(capturedOptions).not.toBeNull();
    });
    await waitFor(() => {
      expect(model.getItem('foo.md')).not.toBeNull();
    });

    // Simulate Pierre's drop: store moves directly to canonical 'subfolder/foo.md'.
    model.focusPath('foo.md');
    model.move('foo.md', 'subfolder/foo.md');
    expect(model.getFocusedPath()).toBe('subfolder/foo.md');

    // Fire the server-response side of handleTreeRename (which calls
    // applyRenamedDocuments → extensionless-rename reconciliation). The guard
    // must short-circuit on `getItem('subfolder/foo') === null`.
    const options = capturedOptions as {
      renaming?: { onRename?: (e: RenameEvent) => void };
    } | null;
    const onRename = options?.renaming?.onRename;
    if (!onRename) {
      throw new Error('onRename callback missing');
    }
    onRename({ sourcePath: 'foo.md', destinationPath: 'subfolder/foo.md', isFolder: false });

    // Wait for handleTreeRename to settle. addPage is the earliest
    // observable signal that applyRenamedDocuments started. Focus
    // assertion below catches both pre-existing canonical state and any
    // accidental reconciliation move.
    await waitFor(() => {
      expect(addPageMock).toHaveBeenCalledWith('subfolder/foo');
    });

    // Pierre's store retains the canonical path; no spurious throw, no
    // sidebar-out-of-date toast. Focus stays where Pierre put it.
    expect(model.getFocusedPath()).toBe('subfolder/foo.md');
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  test('FOLDER_CASCADE — children pre-canonical in Pierre store; reconciliation guard short-circuits per child', async () => {
    // Folder rename: server returns one `renamed[]` entry per child doc
    // whose path shifted. Pierre's folder-rename internals have already
    // moved each child to its canonical destination path BEFORE
    // applyRenamedDocuments runs. The reconciliation guard's positive
    // selector (`getItem(toDocName) == null`) must short-circuit each
    // entry — if it mistakenly calls `model.move()` on the extensionless
    // form for any cascade child, Pierre throws.
    renameResponseBody = {
      renamed: [
        { fromDocName: 'notes/a', toDocName: 'essays/a' },
        { fromDocName: 'notes/b', toDocName: 'essays/b' },
      ],
      renamedAssets: [],
      rewrittenDocs: [],
    };
    documentsFetchResult = [
      {
        kind: 'document',
        docName: 'notes/a',
        docExt: '.md',
        size: 1,
        modified: '2026-05-22T00:00:00.000Z',
      },
      {
        kind: 'document',
        docName: 'notes/b',
        docExt: '.md',
        size: 1,
        modified: '2026-05-22T00:00:00.000Z',
      },
    ];

    render(<FileTree />);

    await waitFor(() => {
      expect(capturedOptions).not.toBeNull();
    });
    await waitFor(() => {
      expect(model.getItem('notes/a.md')).not.toBeNull();
    });

    // Pierre's folder-cascade has already moved children to canonical.
    model.focusPath('notes/a.md');
    model.move('notes/a.md', 'essays/a.md');
    model.move('notes/b.md', 'essays/b.md');
    expect(model.getFocusedPath()).toBe('essays/a.md');

    // Fire applyRenamedDocuments — guard must short-circuit both entries
    // since `getItem('essays/a') === null` and `getItem('essays/b') === null`.
    const options = capturedOptions as {
      renaming?: { onRename?: (e: RenameEvent) => void };
    } | null;
    const onRename = options?.renaming?.onRename;
    if (!onRename) {
      throw new Error('onRename callback missing');
    }
    onRename({ sourcePath: 'notes/', destinationPath: 'essays/', isFolder: true });

    // Wait for handleTreeRename to settle. Same reasoning as DRAG_DROP:
    // addPage is the earliest observable signal; focus assertion below
    // catches both pre-existing canonical state and accidental moves.
    await waitFor(() => {
      expect(addPageMock).toHaveBeenCalledWith('essays/a');
    });

    // Both children retain their canonical paths; no spurious throw.
    expect(model.getFocusedPath()).toBe('essays/a.md');
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  test('NULL_SOURCE — server returns fromDocName absent from current state; source==null guard short-circuits', async () => {
    // Race scenarios: user deleted the file client-side between rename
    // initiation and server response (current React state no longer has
    // fromDocName), OR server returns a stale entry that React's state
    // moved past. The `if (source == null) continue` guard at
    // extensionless-rename reconciliation must short-circuit such entries —
    // no spurious `model.move()` call, no throw, focus unchanged.
    renameResponseBody = {
      renamed: [{ fromDocName: 'nonexistent', toDocName: 'whatever' }],
      renamedAssets: [],
      rewrittenDocs: [],
    };

    render(<FileTree />);
    await waitFor(() => {
      expect(capturedOptions).not.toBeNull();
    });
    await waitFor(() => {
      expect(model.getItem('foo.md')).not.toBeNull();
    });

    // Pin pre-rename state.
    model.focusPath('foo.md');
    model.selectedPaths = ['foo.md'];
    const focusBefore = model.getFocusedPath();
    const itemsBefore = Array.from(model.items.keys()).sort();

    // Trigger applyRenamedDocuments via Pierre's onRename. Do NOT call
    // `simulatePierreCommitRename` — its `model.move()` would throw on
    // the nonexistent source. We're testing the React-side guard, not
    // Pierre's commit semantics, so fire onRename directly and leave
    // Pierre's store untouched.
    const options = capturedOptions as {
      renaming?: { onRename?: (e: RenameEvent) => void };
    } | null;
    const onRename = options?.renaming?.onRename;
    if (!onRename) {
      throw new Error('onRename callback missing');
    }
    onRename({
      sourcePath: 'nonexistent.md',
      destinationPath: 'whatever',
      isFolder: false,
    });

    // `addPage(toDocName)` fires unconditionally in `applyRenamedDocuments`
    // (before the setDocuments updater where reconcile runs) — works as
    // the wait signal even when the guard short-circuits the reconcile.
    await waitFor(() => {
      expect(addPageMock).toHaveBeenCalledWith('whatever');
    });

    // Contract: guard short-circuited cleanly. No throw, no toast, no
    // model state change (Pierre's store unchanged because nothing
    // matched in current; React's documents unchanged because
    // applyRenameToDocuments couldn't find the entry either).
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(model.getFocusedPath()).toBe(focusBefore);
    expect(model.getSelectedPaths()).toEqual(['foo.md']);
    expect(Array.from(model.items.keys()).sort()).toEqual(itemsBefore);
  });
});
