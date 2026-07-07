import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { type ReactNode, useEffect } from 'react';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';
import {
  expectVisualClassTokens,
  expectVisualClassTokensAbsent,
} from '@/test-utils/visual-contract';

function PassThrough({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

function ElementPassThrough({
  children,
  asChild: _asChild,
  ...props
}: {
  children?: ReactNode;
  asChild?: boolean;
  [key: string]: unknown;
}) {
  return <div {...props}>{children}</div>;
}

function Button({
  children,
  asChild: _asChild,
  onCheckedChange: _onCheckedChange,
  onClick,
  onSelect,
  size: _size,
  variant: _variant,
  ...props
}: {
  children?: ReactNode;
  asChild?: boolean;
  onCheckedChange?: unknown;
  onClick?: () => void;
  onSelect?: () => void;
  size?: unknown;
  variant?: unknown;
  [key: string]: unknown;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        onClick?.();
        onSelect?.();
      }}
      {...props}
    >
      {children}
    </button>
  );
}

type FolderState = { folderCount: number; expandedCount: number };

let sidebarState: 'expanded' | 'collapsed' = 'expanded';
let workspace: { contentDir: string; pathSeparator: string } | null = {
  contentDir: '/tmp/open-knowledge',
  pathSeparator: '/',
};
let activeDocName: string | null = 'docs/current';
let activeTarget: { kind: 'folder'; folderPath: string } | null = {
  kind: 'folder',
  folderPath: 'docs',
};
let folderState: FolderState = { folderCount: 2, expandedCount: 1 };
let hasTemplates = true;
let mergedConfig: {
  appearance?: { sidebar?: { showHiddenFiles?: boolean } };
} | null = {
  appearance: { sidebar: { showHiddenFiles: false } },
};
let sidebarSearchThrows = false;
let projectPatchResult: { ok: true } | { ok: false; error: unknown } = { ok: true };
let openInAgentSubmenuProps: Array<{
  input: unknown;
}> = [];
let toastSuccesses: unknown[][] = [];
let toastErrors: unknown[][] = [];
let pillRenderErrors: unknown[][] = [];
const treeListeners = new Set<() => void>();

const treeCalls = {
  collapseAll: mock(() => {}),
  createFromTemplate: mock((_parentDir: string, _templateName: string) => {}),
  expandAll: mock(() => {}),
  startCreating: mock((_kind: 'file' | 'folder', _parentDir: string) => {}),
  startCreatingFromTemplate: mock((_parentDir: string) => {}),
};
const projectLocalPatch = mock((_patch: unknown) => projectPatchResult);
const showItemInFolderMock = mock((_path: string) => Promise.resolve());
const notifyViewMenuStateChangedMock = mock((_snapshot: unknown) => {});
const onOpenSearch = mock(() => {});

function setFolderState(next: FolderState) {
  folderState = next;
  for (const listener of treeListeners) listener();
}

function installBridge() {
  Object.defineProperty(window, 'okDesktop', {
    configurable: true,
    value: {
      platform: 'darwin',
      editor: {
        notifyViewMenuStateChanged: notifyViewMenuStateChangedMock,
      },
      shell: {
        showItemInFolder: showItemInFolderMock,
      },
      onMenuAction: () => () => {},
    },
  });
}

mock.module('@lingui/react/macro', () => ({
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

mock.module('@/lib/perf', () => ({
  ProfilerBoundary: PassThrough,
}));

mock.module('@/components/FileTree', () => ({
  FileTree: ({ ref }: { ref?: (handle: unknown) => void }) => {
    useEffect(() => {
      const handle = {
        collapseAll: treeCalls.collapseAll,
        createFromTemplate: treeCalls.createFromTemplate,
        expandAll: treeCalls.expandAll,
        getFolderState: () => folderState,
        isCreationTargetCleared: () => false,
        startCreating: treeCalls.startCreating,
        startCreatingFromTemplate: treeCalls.startCreatingFromTemplate,
        subscribe: (listener: () => void) => {
          treeListeners.add(listener);
          return () => treeListeners.delete(listener);
        },
      };
      ref?.(handle);
      return () => ref?.(null);
    }, [ref]);
    return <div data-testid="file-tree-stub" />;
  },
}));

mock.module('@/components/ConflictsSection', () => ({
  ConflictsSection: () => <div data-testid="conflicts-section" />,
}));

// Heavy sidebar child (pulls in skill-actions → dropdown submenu + handoff
// builders). Not under test here; stubbed like FileTree/ConflictsSection so the
// sidebar's own behavior tests don't depend on the skills subtree's deep graph.
mock.module('@/components/SkillsSidebarSection', () => ({
  SkillsSidebarSection: () => <div data-testid="skills-sidebar-section" />,
}));

mock.module('@/components/ProjectSwitcher', () => ({
  ProjectSwitcher: () => <button type="button">Project switcher</button>,
}));

mock.module('@/components/SidebarSearchBar', () => ({
  SidebarSearchBar: ({ onClick }: { onClick: () => void }) => {
    if (sidebarSearchThrows) throw new Error('search pill render failed');
    return (
      <button data-testid="sidebar-search" type="button" onClick={onClick}>
        Search
      </button>
    );
  },
  onPillRenderError: (...args: unknown[]) => {
    pillRenderErrors.push(args);
  },
}));

mock.module('@/components/UpdateNotices', () => ({
  UpdateNotices: () => <div data-testid="update-notices" />,
}));

mock.module('@/components/handoff/OpenInAgentEmptySpaceSubmenu', () => ({
  OpenInAgentEmptySpaceSubmenu: (props: { input: unknown }) => {
    openInAgentSubmenuProps.push(props);
    return <div data-testid="open-in-agent-empty-space-submenu" />;
  },
}));

mock.module('@/components/handoff/useHandoffDispatch', () => ({
  buildFolderHandoffInput: () => ({ docContext: null, docPath: '', folderRelativePath: 'docs' }),
  buildHandoffInput: () => ({
    docContext: { docName: 'docs/current' },
    docPath: 'docs/current.md',
  }),
  buildProjectScopedHandoffInput: ({ workspace: inputWorkspace }: { workspace: unknown }) =>
    inputWorkspace ? { docContext: null, docPath: '', projectDir: '/tmp/open-knowledge' } : null,
  useHandoffDispatch: () => ({ dispatch: mock(() => Promise.resolve({ ok: true })) }),
}));

mock.module('@/components/handoff/useInstalledAgents', () => ({
  useInstalledAgents: () => ({ states: { codex: { installed: true } } }),
}));

mock.module('@/components/ui/button', () => ({
  Button,
}));

mock.module('@/components/ui/context-menu', () => ({
  ContextMenu: PassThrough,
  ContextMenuContent: ({ children }: { children?: ReactNode }) => <div role="menu">{children}</div>,
  ContextMenuItem: ({
    children,
    disabled,
    onSelect,
    ...props
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onSelect?: () => void;
    [key: string]: unknown;
  }) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        if (!disabled) onSelect?.();
      }}
      {...props}
    >
      {children}
    </button>
  ),
  ContextMenuCheckboxItem: ({
    checked,
    children,
    disabled,
    onCheckedChange,
    ...props
  }: {
    checked?: boolean;
    children?: ReactNode;
    disabled?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    [key: string]: unknown;
  }) => (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked ? 'true' : 'false'}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onCheckedChange?.(!checked);
      }}
      {...props}
    >
      {children}
    </button>
  ),
  ContextMenuSeparator: () => <hr data-testid="context-menu-separator" />,
  ContextMenuSub: PassThrough,
  ContextMenuSubContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ContextMenuSubTrigger: Button,
  ContextMenuTrigger: PassThrough,
}));

mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: PassThrough,
  DropdownMenuContent: ({ children }: { children?: ReactNode }) => (
    <div data-testid="tree-options-menu">{children}</div>
  ),
  DropdownMenuItem: Button,
  DropdownMenuSeparator: () => null,
  DropdownMenuTrigger: PassThrough,
}));

mock.module('@/components/ui/sidebar', () => ({
  Sidebar: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    <aside data-testid="sidebar" {...props}>
      {children}
    </aside>
  ),
  SidebarContent: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    <main data-testid="sidebar-content" {...props}>
      {children}
    </main>
  ),
  SidebarFooter: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    <footer data-testid="sidebar-footer" {...props}>
      {children}
    </footer>
  ),
  SidebarHeader: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    <header data-testid="sidebar-header" {...props}>
      {children}
    </header>
  ),
  SidebarMenu: ElementPassThrough,
  SidebarMenuItem: ElementPassThrough,
  SidebarGroup: ElementPassThrough,
  SidebarGroupContent: ElementPassThrough,
  SidebarGroupLabel: ElementPassThrough,
  SidebarRail: ({ enableToggle }: { enableToggle?: boolean }) => (
    <button data-enable-toggle={String(enableToggle)} data-testid="sidebar-rail" type="button" />
  ),
  useSidebar: () => ({ state: sidebarState }),
}));

mock.module('@/components/ui/tooltip', () => ({
  Tooltip: PassThrough,
  TooltipContent: ({ children }: { children?: ReactNode }) => <div role="tooltip">{children}</div>,
  TooltipTrigger: PassThrough,
}));

mock.module('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    activeDocName,
    activeTarget,
  }),
}));

function templateEntries(folderPath: string | null) {
  if (!hasTemplates) return [];
  if (folderPath === '') {
    return [
      {
        name: 'root-daily',
        path: '.ok/templates/root-daily.md',
        scope: 'local',
        source_folder: '',
        title: 'Root daily',
      },
    ];
  }
  return [
    {
      name: 'daily',
      path: `${folderPath ?? ''}/.ok/templates/daily.md`,
      scope: 'local',
      source_folder: folderPath ?? '',
      title: 'Daily',
    },
  ];
}

mock.module('@/hooks/use-folder-config', () => ({
  useFolderConfig: (folderPath: string | null) => ({
    state: {
      status: 'ready',
      data: { folder: { templates_available: templateEntries(folderPath) } },
    },
  }),
}));

mock.module('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    merged: mergedConfig,
    projectLocalBinding: {
      patch: projectLocalPatch,
    },
  }),
}));

mock.module('@/lib/use-workspace', () => ({
  useWorkspace: () => workspace,
}));

mock.module('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastErrors.push(args),
    success: (...args: unknown[]) => toastSuccesses.push(args),
  },
}));

async function renderSidebar() {
  const { FileSidebar } = await import('./FileSidebar');
  return render(<FileSidebar onOpenSearch={onOpenSearch} />);
}

describe('FileSidebar runtime behavior', () => {
  beforeEach(() => {
    cleanup();
    sidebarState = 'expanded';
    workspace = { contentDir: '/tmp/open-knowledge', pathSeparator: '/' };
    activeDocName = 'docs/current';
    activeTarget = { kind: 'folder', folderPath: 'docs' };
    folderState = { folderCount: 2, expandedCount: 1 };
    hasTemplates = true;
    mergedConfig = { appearance: { sidebar: { showHiddenFiles: false } } };
    sidebarSearchThrows = false;
    projectPatchResult = { ok: true };
    openInAgentSubmenuProps = [];
    toastSuccesses = [];
    toastErrors = [];
    pillRenderErrors = [];
    treeListeners.clear();
    for (const fn of [
      treeCalls.collapseAll,
      treeCalls.createFromTemplate,
      treeCalls.expandAll,
      treeCalls.startCreating,
      treeCalls.startCreatingFromTemplate,
      projectLocalPatch,
      showItemInFolderMock,
      notifyViewMenuStateChangedMock,
      onOpenSearch,
    ]) {
      fn.mockClear();
    }
    Object.defineProperty(window, 'okDesktop', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: mock(() => Promise.resolve()),
      },
    });
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(window, 'okDesktop', {
      configurable: true,
      value: undefined,
    });
  });

  test('web mode keeps the Files label, spread toolbar layout, search entry, and no Electron chrome classes', async () => {
    await renderSidebar();

    const header = screen.getByTestId('sidebar-header');
    expect(screen.getByText('Files')).toBeTruthy();
    expectVisualClassTokens(header.className, ['justify-between']);
    expectVisualClassTokensAbsent(header.className, [
      '[-webkit-app-region:drag]',
      'overflow-x-clip',
    ]);
    expect(header.getAttribute('data-electron-drag')).toBeNull();
    // No macOS traffic-light reserve on web — there are no traffic lights.
    expect(screen.queryByTestId('sidebar-traffic-light-reserve')).toBeNull();
    expect(screen.queryByText('Project switcher')).toBeNull();

    fireEvent.click(screen.getByTestId('sidebar-search'));
    expect(onOpenSearch).toHaveBeenCalledTimes(1);
  });

  test('Electron mode moves identity to the footer and applies drag/no-drag chrome treatment', async () => {
    installBridge();
    await renderSidebar();

    const header = screen.getByTestId('sidebar-header');
    const toolbar = screen.getByTestId('sidebar-toolbar');
    const pillRow = screen.getByTestId('sidebar-search').parentElement as HTMLElement;

    expect(screen.queryByText('Files')).toBeNull();
    expect(screen.getByText('Project switcher')).toBeTruthy();
    expect(header.getAttribute('data-electron-drag')).toBe('');
    // `justify-between` + the non-shrinkable reserve spacer keep the action
    // cluster clear of the macOS traffic lights structurally; `overflow-x-clip`
    // degrades an over-budget cluster toward the interior, not under the chrome.
    expectVisualClassTokens(header.className, [
      'justify-between',
      'overflow-x-clip',
      '[-webkit-app-region:drag]',
    ]);
    const reserve = screen.getByTestId('sidebar-traffic-light-reserve');
    // `self-stretch` makes the reserve span the full header height so the whole
    // traffic-light strip stays a draggable window region.
    expectVisualClassTokens(reserve.className, [
      'w-[var(--ok-titlebar-reserve-left,0px)]',
      'shrink-0',
      'self-stretch',
    ]);
    expectVisualClassTokens(toolbar.className, ['[&>*]:[-webkit-app-region:no-drag]']);
    expectVisualClassTokens(pillRow.className, ['[-webkit-app-region:no-drag]']);
    expect(screen.getByTestId('sidebar-rail').getAttribute('data-enable-toggle')).toBe('false');
  });

  test('collapsed Electron sidebar fades the toolbar and search pill in lockstep', async () => {
    installBridge();
    sidebarState = 'collapsed';
    await renderSidebar();

    expectVisualClassTokens(screen.getByTestId('sidebar-header').className, [
      'opacity-0',
      'motion-safe:transition-opacity',
      'motion-safe:duration-100',
      'motion-safe:ease-out',
    ]);
    const pillRow = screen.getByTestId('sidebar-search').parentElement as HTMLElement;
    expectVisualClassTokens(pillRow.className, [
      'opacity-0',
      'motion-safe:transition-opacity',
      'motion-safe:duration-100',
      'motion-safe:ease-out',
    ]);
  });

  test('toolbar actions use the active folder while tree-state actions smart-hide no-op menu items', async () => {
    await renderSidebar();
    await waitFor(() => expect(treeListeners.size).toBe(1));

    fireEvent.click(screen.getAllByRole('button', { name: 'New file' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: 'New from template' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Daily' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'New folder' })[0]);
    expect(treeCalls.startCreating).toHaveBeenCalledWith('file', 'docs');
    expect(treeCalls.createFromTemplate).toHaveBeenCalledWith('docs', 'daily');
    expect(treeCalls.startCreating).toHaveBeenCalledWith('folder', 'docs');

    expect(screen.getByRole('button', { name: 'Expand all' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Collapse all' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(treeCalls.expandAll).toHaveBeenCalledTimes(1);
    expect(treeCalls.collapseAll).toHaveBeenCalledTimes(1);

    act(() => setFolderState({ folderCount: 2, expandedCount: 2 }));
    expect(screen.queryByRole('button', { name: 'Expand all' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Collapse all' })).toBeTruthy();

    act(() => setFolderState({ folderCount: 2, expandedCount: 0 }));
    expect(screen.getByRole('button', { name: 'Expand all' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Collapse all' })).toBeNull();
  });

  test('empty-space menu renders ordered project-root actions and routes each runtime effect', async () => {
    installBridge();
    await renderSidebar();
    await waitFor(() => expect(treeListeners.size).toBe(1));

    const itemIds = [
      'empty-space-menu-new-file',
      'empty-space-menu-new-from-template',
      'empty-space-menu-new-folder',
      'empty-space-menu-reveal-in-finder',
      'open-in-agent-empty-space-submenu',
      'empty-space-menu-copy-full-path',
      'empty-space-menu-show-hidden-files',
      'empty-space-menu-expand-all',
      'empty-space-menu-collapse-all',
    ];
    const positions = itemIds.map((id) => {
      const element = screen.getByTestId(id);
      return Array.from(element.parentElement?.children ?? []).indexOf(element);
    });
    expect(positions).toEqual([...positions].sort((a, b) => a - b));

    fireEvent.click(screen.getByTestId('empty-space-menu-new-file'));
    fireEvent.click(screen.getByTestId('empty-space-menu-new-from-template'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Root daily' }));
    fireEvent.click(screen.getByTestId('empty-space-menu-new-folder'));
    expect(treeCalls.startCreating).toHaveBeenCalledWith('file', '');
    expect(treeCalls.createFromTemplate).toHaveBeenCalledWith('', 'root-daily');
    expect(treeCalls.startCreating).toHaveBeenCalledWith('folder', '');

    fireEvent.click(screen.getByTestId('empty-space-menu-reveal-in-finder'));
    expect(showItemInFolderMock).toHaveBeenCalledWith('/tmp/open-knowledge');

    fireEvent.click(screen.getByTestId('empty-space-menu-copy-full-path'));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/tmp/open-knowledge'),
    );
    expect(toastSuccesses[0]?.[0]).toBe('Copied full path');

    fireEvent.click(screen.getByTestId('empty-space-menu-show-hidden-files'));
    expect(projectLocalPatch).toHaveBeenCalledWith({
      appearance: { sidebar: { showHiddenFiles: true } },
    });

    expect(openInAgentSubmenuProps.at(-1)?.input).toEqual({
      docContext: null,
      docPath: '',
      projectDir: '/tmp/open-knowledge',
    });
  });

  test('toolbar and empty-space menu hide "New from template" when no templates exist', async () => {
    // Both template-create surfaces drop the entry entirely when the resolved
    // cascade is empty — the toolbar button and the empty-space submenu, not
    // just a disabled placeholder.
    hasTemplates = false;
    installBridge();
    await renderSidebar();
    await waitFor(() => expect(treeListeners.size).toBe(1));

    expect(screen.queryByRole('button', { name: 'New from template' })).toBeNull();
    expect(screen.queryByTestId('empty-space-menu-new-from-template')).toBeNull();
    // Sibling create actions still render.
    expect(screen.getByTestId('empty-space-menu-new-file')).toBeTruthy();
    expect(screen.getByTestId('empty-space-menu-new-folder')).toBeTruthy();
  });

  test('View menu state pushes merged visibility and tree smart-hide state to the desktop bridge', async () => {
    installBridge();
    await renderSidebar();

    await waitFor(() =>
      expect(notifyViewMenuStateChangedMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sidebarVisible: true,
          canCollapseAll: true,
          canExpandAll: true,
          showHiddenFiles: false,
        }),
      ),
    );

    notifyViewMenuStateChangedMock.mockClear();
    act(() => setFolderState({ folderCount: 2, expandedCount: 2 }));
    await waitFor(() =>
      expect(notifyViewMenuStateChangedMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sidebarVisible: true,
          canCollapseAll: true,
          canExpandAll: false,
          showHiddenFiles: false,
        }),
      ),
    );
  });

  test('search pill render failures are contained to the pill row and reset when sidebar state changes', async () => {
    const originalConsoleError = console.error;
    console.error = mock(() => {}) as never;
    try {
      sidebarSearchThrows = true;
      const rendered = await renderSidebar();

      await waitFor(() => expect(pillRenderErrors.length).toBeGreaterThan(0));
      expect(screen.queryByTestId('sidebar-search')).toBeNull();
      expect(screen.getByTestId('file-tree-stub')).toBeTruthy();
      expect(screen.getByTestId('sidebar-footer')).toBeTruthy();

      sidebarSearchThrows = false;
      sidebarState = 'collapsed';
      const { FileSidebar } = await import('./FileSidebar');
      rendered.rerender(<FileSidebar onOpenSearch={onOpenSearch} />);
      expect(await screen.findByTestId('sidebar-search')).toBeTruthy();
    } finally {
      console.error = originalConsoleError;
    }
  });
});
