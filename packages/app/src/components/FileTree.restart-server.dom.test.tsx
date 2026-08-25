/**
 * Sidebar "Could not reach server" recovery affordance.
 *
 * When the collab server exits under an open window, the sidebar listing is
 * the surface the user is actually looking at — and it offered no way out.
 * These tests drive the real FileTree (testing-library + jsdom) with a
 * network-failing listing and assert the restart action renders, is absent
 * with nothing to restart, is absent for server-answered errors (a live
 * server needs no respawn), and reaches the desktop bridge when pressed.
 *
 * `@pierre/trees/react`'s FileTree is mocked to render the `header` prop so
 * the populated-tree notice row is observable.
 */

import { i18n } from '@lingui/core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

i18n.load('en', {});
i18n.activate('en');

function PassThrough({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

// --- mutable per-test state ---
let listingFails = false;
let listingStatus = 200;
let listingDocuments: unknown[] = [];

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
    modified: '2026-08-18T00:00:00.000Z',
  };
}

function makeFetchMock() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('/api/documents')) {
      if (listingFails) throw new TypeError('Failed to fetch');
      if (listingStatus !== 200) return jsonResponse({ title: 'Internal server error' }, 500);
      return jsonResponse({ documents: listingDocuments });
    }
    if (url === '/api/workspace') {
      return jsonResponse({ contentDir: '/tmp/ok', pathSeparator: '/', symlinkResolved: true });
    }
    return jsonResponse({ ok: true });
  });
}

const restartServer = vi.fn(async () => ({ ok: true as const }));

function installBridge() {
  (window as unknown as { okDesktop?: unknown }).okDesktop = {
    platform: 'darwin',
    config: { projectPath: '/tmp/ok', collabUrl: 'ws://127.0.0.1:5200/collab' },
    restartServer,
  };
}

// --- module mocks (mirrors the sibling FileTree dom-test harnesses) ---

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

vi.doMock('sonner', () => ({ toast: { success: vi.fn(() => {}), error: vi.fn(() => {}) } }));
vi.doMock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    activeDocName: null,
    activeTarget: null,
    closeTabs: vi.fn(() => {}),
    closeDocument: vi.fn(() => {}),
    isNewTabActive: false,
    openTarget: vi.fn(() => {}),
    prewarm: () => {},
    reconcileLocalRemoval: vi.fn(async () => {}),
    reconcileLocalRename: vi.fn(async () => {}),
  }),
}));
vi.doMock('@/components/PageListContext', () => ({
  usePageList: () => ({ addPage: vi.fn(() => {}) }),
}));
vi.doMock('./ui/sidebar', () => ({
  useSidebar: () => ({ notifySidebarFileSelected: vi.fn(() => {}) }),
}));
vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    okignoreBinding: null,
    projectLocalBinding: null,
    merged: { appearance: { sidebar: {} } },
  }),
}));
vi.doMock('./handoff/useInstalledAgents', () => ({ useInstalledAgents: () => ({ states: {} }) }));
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
  Button: ({ children, ...props }: { children?: ReactNode; [k: string]: unknown }) => (
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
  FileTree: ({ header }: { header?: ReactNode }) => (
    <div data-testid="fake-pierre-tree" role="tree">
      {header}
    </div>
  ),
}));

const { FileTree } = await import('./FileTree');

const RESTART_LABEL = /restart server/i;

describe('FileTree unreachable-server restart action', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    listingFails = false;
    listingStatus = 200;
    listingDocuments = [];
    restartServer.mockClear();
    globalThis.fetch = makeFetchMock() as unknown as typeof fetch;
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleWarnSpy.mockRestore();
    (window as unknown as { okDesktop?: unknown }).okDesktop = undefined;
  });

  test('offers the restart action on the unreachable-server empty state', async () => {
    installBridge();
    listingFails = true;
    render(<FileTree />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').toContain('Could not reach server');
    expect(await screen.findByRole('button', { name: RESTART_LABEL })).toBeTruthy();
  });

  test('omits the restart action when there is no bridge to restart through', async () => {
    listingFails = true;
    render(<FileTree />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').toContain('Could not reach server');
    expect(screen.queryByRole('button', { name: RESTART_LABEL })).toBeNull();
  });

  test('omits the restart action when the server answered with an error', async () => {
    installBridge();
    listingStatus = 500;
    render(<FileTree />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').toContain('Internal server error');
    expect(screen.queryByRole('button', { name: RESTART_LABEL })).toBeNull();
  });

  test('pressing the action restarts this project through the desktop bridge', async () => {
    installBridge();
    listingFails = true;
    render(<FileTree />);

    const restart = await screen.findByRole('button', { name: RESTART_LABEL });
    await userEvent.click(restart);

    await waitFor(() => expect(restartServer).toHaveBeenCalledTimes(1));
    expect(restartServer).toHaveBeenCalledWith('/tmp/ok');
  });

  test('a restart already in flight disables the action instead of spawning twice', async () => {
    installBridge();
    listingFails = true;
    let releaseRestart!: (value: { ok: true }) => void;
    restartServer.mockImplementationOnce(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          releaseRestart = resolve;
        }),
    );
    render(<FileTree />);

    const restart = await screen.findByRole('button', { name: RESTART_LABEL });
    await userEvent.click(restart);
    expect((restart as HTMLButtonElement).disabled).toBe(true);

    await userEvent.click(restart);
    expect(restartServer).toHaveBeenCalledTimes(1);

    releaseRestart({ ok: true });
    await waitFor(() => expect((restart as HTMLButtonElement).disabled).toBe(false));
  });

  test('offers the restart action alongside the header notice on a populated tree', async () => {
    installBridge();
    listingDocuments = [docEntry('notes/a')];
    render(<FileTree />);

    await screen.findByTestId('fake-pierre-tree');
    expect(screen.queryByRole('button', { name: RESTART_LABEL })).toBeNull();

    // A refresh that cannot reach the server leaves the already-listed rows on
    // screen, so the recovery affordance has to live in the header notice slot
    // rather than the empty state.
    listingFails = true;
    window.dispatchEvent(new Event('focus'));

    await waitFor(() =>
      expect((screen.getByRole('alert').textContent ?? '').includes('Could not reach server')).toBe(
        true,
      ),
    );
    const restart = await screen.findByRole('button', { name: RESTART_LABEL });
    // The notice is an aria-live region; a focusable descendant inside one
    // diverges from what screen readers announce.
    expect(screen.getByRole('alert').contains(restart)).toBe(false);
  });
});
