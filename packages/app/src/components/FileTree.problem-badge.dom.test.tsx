import { act, cleanup, render, waitFor } from '@testing-library/react';
import { createElement, type ReactNode, useLayoutEffect, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { subscribeToDocPanelTabRequests } from '@/components/doc-panel-events';
import { OK_PROBLEM_BADGE_ATTR } from '@/components/file-tree-problem-indicators';
import { emitDocumentsChanged } from '@/lib/documents-events';
import { replaceValidationFromCounts } from '@/lib/validation-store';
import type { FileEntry } from './file-tree-utils';

const PROBLEM_DOC_NAME = 'notes/source';
const PROBLEM_ROW_PATH = 'notes/source.mdx';
const CLEAN_ROW_PATH = 'notes/clean.mdx';
const ASSET_ROW_PATH = 'notes/diagram.png';
const GHOST_ROW_PATH = 'notes/ghost.mdx';

let events: string[] = [];
let mergedConfig: unknown = null;

const DOCUMENTS: FileEntry[] = [
  { kind: 'folder', path: 'notes', size: 0, modified: '2026-08-18T00:00:00.000Z' },
  {
    kind: 'document',
    docName: PROBLEM_DOC_NAME,
    docExt: '.mdx',
    size: 1,
    modified: '2026-08-18T00:00:00.000Z',
  },
  {
    kind: 'document',
    docName: 'notes/clean',
    docExt: '.mdx',
    size: 1,
    modified: '2026-08-18T00:00:00.000Z',
  },
  {
    kind: 'asset',
    path: ASSET_ROW_PATH,
    assetExt: 'png',
    mediaKind: null,
    size: 1,
    modified: '2026-08-18T00:00:00.000Z',
    referencedBy: [],
  },
];
let listedDocuments: FileEntry[] = DOCUMENTS;

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

function PassThrough({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

vi.doMock('sonner', () => ({
  toast: { success: vi.fn(() => {}), error: vi.fn(() => {}) },
}));

vi.doMock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

vi.doMock('@/hooks/use-git-sync-status', () => ({
  useGitSyncStatusDetailed: () => ({
    status: { hasRemote: false, syncEnabled: false, behind: 0, ahead: 0 },
    fetchError: null,
  }),
  useGitSyncStatus: () => ({ hasRemote: false, syncEnabled: false, behind: 0, ahead: 0 }),
}));

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    activeDocName: 'notes/other',
    activeTarget: { kind: 'doc', target: 'notes/other', docName: 'notes/other' },
    closeTabs: () => {},
    closeDocument: () => {},
    isNewTabActive: false,
    openTarget: (
      target: { kind?: string; docName?: string; assetPath?: string },
      options?: { disposition?: string },
    ) => {
      events.push(
        target.kind === 'asset'
          ? `open-asset:${target.assetPath}:${options?.disposition}`
          : `open:${target.docName}:${options?.disposition}`,
      );
    },
    prewarm: () => {},
    reconcileLocalRemoval: async () => {},
    reconcileLocalRename: async () => {},
    setSkillsSidebar: () => {},
  }),
}));

vi.doMock('@/components/PageListContext', () => ({
  usePageList: () => ({
    addPage: (docName: string) => events.push(`addPage:${docName}`),
    pageMeta: new Map(),
    pages: [],
  }),
}));

vi.doMock('./ui/sidebar', () => ({
  useSidebar: () => ({ notifySidebarFileSelected: () => {} }),
}));

vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    okignoreBinding: null,
    projectLocalBinding: null,
    merged: mergedConfig,
  }),
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

vi.doMock('@/components/ui/dialog', () => ({ Dialog: PassThrough }));

vi.doMock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: PassThrough,
  DropdownMenuCheckboxItem: PassThrough,
  DropdownMenuContent: PassThrough,
  DropdownMenuItem: PassThrough,
  DropdownMenuSeparator: () => null,
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

function PierreTreeShadowRows() {
  const hostRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    for (const path of [PROBLEM_ROW_PATH, CLEAN_ROW_PATH, ASSET_ROW_PATH, GHOST_ROW_PATH]) {
      const row = document.createElement('div');
      row.setAttribute('data-type', 'item');
      row.setAttribute('data-item-path', path);
      row.setAttribute('data-item-type', 'file');
      const content = document.createElement('div');
      content.setAttribute('data-item-section', 'content');
      content.textContent = path;
      row.appendChild(content);
      const action = document.createElement('div');
      action.setAttribute('data-item-section', 'action');
      row.appendChild(action);
      shadow.append(row);
    }
  }, []);

  return createElement('ok-file-tree', { ref: hostRef });
}

vi.doMock('@pierre/trees/react', () => ({
  useFileTree: () => ({ model }),
  FileTree: ({
    onClickCapture,
  }: {
    onClickCapture?: (event: unknown) => void;
    [key: string]: unknown;
  }) => (
    <div
      data-testid="fake-pierre-tree"
      role="tree"
      onClickCapture={onClickCapture as never}
      data-file-tree-virtualized-root=""
    >
      <PierreTreeShadowRows />
    </div>
  ),
}));

const { FileTree } = await import('./FileTree');

function shadowRoot(): ShadowRoot {
  const host = document.querySelector('ok-file-tree');
  if (!host?.shadowRoot) throw new Error('tree host has no shadow root');
  return host.shadowRoot;
}

function findBadge(rowPath: string): HTMLElement | null {
  return (
    shadowRoot()
      .querySelector(`[data-item-path="${rowPath}"]`)
      ?.querySelector<HTMLElement>(`[${OK_PROBLEM_BADGE_ATTR}]`) ?? null
  );
}

async function clickBadge(badge: HTMLElement): Promise<void> {
  await act(async () => {
    badge.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }),
    );
    await Promise.resolve();
  });
}

async function pressBadge(badge: HTMLElement, key: 'Enter' | ' '): Promise<void> {
  await act(async () => {
    badge.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, composed: true }),
    );
    await Promise.resolve();
  });
}

function setProblemCounts(errorCount: number): void {
  act(() => {
    replaceValidationFromCounts([
      {
        file: PROBLEM_ROW_PATH,
        lint: { errorCount, warningCount: 0 },
        links: { errorCount: 0, warningCount: 0 },
      },
    ]);
  });
}

async function renderTreeWithProblems(): Promise<ReturnType<typeof render>> {
  const view = render(<FileTree />);
  setProblemCounts(2);
  await waitFor(() => {
    expect(findBadge(PROBLEM_ROW_PATH)).not.toBeNull();
  });
  return view;
}

describe('FileTree problem badge', () => {
  let unsubscribeFromTabRequests: () => void;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    events = [];
    model = new StubModel();
    mergedConfig = null;
    listedDocuments = DOCUMENTS;
    replaceValidationFromCounts([]);
    unsubscribeFromTabRequests = subscribeToDocPanelTabRequests((tab, request) => {
      events.push(`tab:${tab}:${request.scope ?? 'unscoped'}:${request.focus ?? 'no-focus'}`);
    });
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('/api/documents')) return jsonResponse({ documents: listedDocuments });
      if (url === '/api/workspace') {
        return jsonResponse({
          contentDir: '/tmp/open-knowledge',
          pathSeparator: '/',
          symlinkResolved: true,
        });
      }
      return jsonResponse({});
    });
  });

  afterEach(() => {
    unsubscribeFromTabRequests();
    fetchSpy.mockRestore();
    replaceValidationFromCounts([]);
    cleanup();
  });

  test('activates the clicked file, then asks the panel for that file in doc scope', async () => {
    await renderTreeWithProblems();
    const badge = findBadge(PROBLEM_ROW_PATH);
    expect(badge).not.toBeNull();

    await clickBadge(badge as HTMLElement);

    expect(events).toEqual([`open:${PROBLEM_DOC_NAME}:preview`, 'tab:problems:doc:no-focus']);
  });

  test('keyboard activation asks the Problems panel to take focus', async () => {
    await renderTreeWithProblems();

    await pressBadge(findBadge(PROBLEM_ROW_PATH) as HTMLElement, 'Enter');

    expect(events).toEqual([`open:${PROBLEM_DOC_NAME}:preview`, 'tab:problems:doc:panel']);
  });

  test('a badge click does not also fire the row own navigation', async () => {
    await renderTreeWithProblems();

    await clickBadge(findBadge(PROBLEM_ROW_PATH) as HTMLElement);

    expect(events.filter((entry) => entry.startsWith('open:'))).toHaveLength(1);
  });

  test('a click elsewhere on a badged row still activates the row', async () => {
    await renderTreeWithProblems();
    const label = shadowRoot().querySelector<HTMLElement>(
      `[data-item-path="${PROBLEM_ROW_PATH}"] [data-item-section="content"]`,
    );

    await act(async () => {
      label?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }),
      );
      await Promise.resolve();
    });

    expect(events).toEqual([`open:${PROBLEM_DOC_NAME}:preview`]);
  });

  test('disabled file-tree indicators leave no badge to activate', async () => {
    mergedConfig = { validation: { fileTreeIndicators: false } };
    render(<FileTree />);
    setProblemCounts(2);
    await waitFor(() => expect(shadowRoot().querySelectorAll('[data-item-path]')).toHaveLength(4));

    expect(findBadge(PROBLEM_ROW_PATH)).toBeNull();
    expect(events).toEqual([]);
  });

  test('a badge on a row no document backs opens nothing at all', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    render(<FileTree />);
    act(() => {
      replaceValidationFromCounts([
        {
          file: GHOST_ROW_PATH,
          lint: { errorCount: 1, warningCount: 0 },
          links: { errorCount: 0, warningCount: 0 },
        },
      ]);
    });
    await waitFor(() => {
      expect(findBadge(GHOST_ROW_PATH)).not.toBeNull();
    });

    await clickBadge(findBadge(GHOST_ROW_PATH) as HTMLElement);

    expect(events).toEqual([]);
    expect(debug).toHaveBeenCalled();
    debug.mockRestore();
  });

  test('a badge on an asset row does not ask for a panel the asset view cannot render', async () => {
    render(<FileTree />);
    act(() => {
      replaceValidationFromCounts([
        {
          file: ASSET_ROW_PATH,
          lint: { errorCount: 1, warningCount: 0 },
          links: { errorCount: 0, warningCount: 0 },
        },
      ]);
    });
    await waitFor(() => expect(findBadge(ASSET_ROW_PATH)).not.toBeNull());

    await clickBadge(findBadge(ASSET_ROW_PATH) as HTMLElement);

    expect(events).toEqual([`open-asset:${ASSET_ROW_PATH}:preview`]);
  });

  test('a file-list refresh preserves a focused badge in place', async () => {
    await renderTreeWithProblems();
    const badge = findBadge(PROBLEM_ROW_PATH);
    expect(badge).not.toBeNull();
    badge?.focus();
    expect(shadowRoot().activeElement).toBe(badge);
    const initialDocumentFetches = fetchSpy.mock.calls.filter(([input]) =>
      String(input).startsWith('/api/documents'),
    ).length;

    listedDocuments = [
      ...DOCUMENTS,
      {
        kind: 'document',
        docName: 'notes/new',
        docExt: '.md',
        size: 1,
        modified: '2026-08-18T00:00:00.000Z',
      },
    ];
    act(() => emitDocumentsChanged(['files']));
    await waitFor(() => {
      const documentFetches = fetchSpy.mock.calls.filter(([input]) =>
        String(input).startsWith('/api/documents'),
      ).length;
      expect(documentFetches).toBeGreaterThan(initialDocumentFetches);
    });

    expect(findBadge(PROBLEM_ROW_PATH)).toBe(badge);
    expect(shadowRoot().activeElement).toBe(badge);
  });

  test('a badge re-applied by a later validation update still activates exactly once', async () => {
    await renderTreeWithProblems();
    setProblemCounts(5);
    setProblemCounts(3);

    await clickBadge(findBadge(PROBLEM_ROW_PATH) as HTMLElement);

    expect(events).toEqual([`open:${PROBLEM_DOC_NAME}:preview`, 'tab:problems:doc:no-focus']);
  });

  test('activation reads the latest render, not the one that installed it', async () => {
    const view = await renderTreeWithProblems();
    mergedConfig = { editor: { previewTabs: false } };
    view.rerender(<FileTree />);

    await clickBadge(findBadge(PROBLEM_ROW_PATH) as HTMLElement);

    expect(events).toEqual([`open:${PROBLEM_DOC_NAME}:permanent`, 'tab:problems:doc:no-focus']);
  });
});
