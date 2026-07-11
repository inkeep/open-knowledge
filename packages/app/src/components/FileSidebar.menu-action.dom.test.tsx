import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, waitFor } from '@testing-library/react';
import { type ReactNode, useEffect } from 'react';
import type { ResolvedNavigationTarget } from './navigation-targets';

type MenuAction =
  NonNullable<typeof window.okDesktop> extends { onMenuAction: (cb: infer C) => unknown }
    ? C extends (action: infer A) => unknown
      ? A
      : never
    : never;

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
  size: _size,
  variant: _variant,
  ...props
}: {
  children?: ReactNode;
  asChild?: boolean;
  onCheckedChange?: unknown;
  size?: unknown;
  variant?: unknown;
  [key: string]: unknown;
}) {
  return (
    <button type="button" {...props}>
      {children}
    </button>
  );
}

const ACTIVE_TARGET = {
  kind: 'doc',
  target: 'notes/source',
  docName: 'notes/source',
} satisfies ResolvedNavigationTarget;
let activeTarget: ResolvedNavigationTarget | null = ACTIVE_TARGET;

const notifyViewMenuStateChangedMock = mock(() => {});
const toggleSidebarMock = mock(() => {});
const showItemInFolderMock = mock((_path: string) => Promise.resolve());
const handoffDispatchMock = mock((_target: string, _input: unknown) =>
  Promise.resolve({ ok: true }),
);
const treeCalls = {
  collapseAll: mock(() => {}),
  expandAll: mock(() => {}),
  startCreating: mock((_kind: 'file' | 'folder', _parentDir: string) => {}),
  startCreatingFromTemplate: mock((_parentDir: string) => {}),
};
const projectLocalPatch = mock((_patch: unknown) => ({ ok: true as const }));
// Production `projectLocalBinding` keeps its identity across config-value
// changes (the provider swaps only `config` on binding updates), so the
// menu-action effect re-binds on a visibility flip ONLY when the flipped
// value itself is in its dependency array. The harness must mirror that:
// a stable binding object plus a merged config swapped between renders —
// a fresh binding per render would re-subscribe every render and mask
// stale-closure regressions in the effect's deps.
const projectLocalBindingStub = { patch: projectLocalPatch };
const DEFAULT_MERGED_CONFIG = { appearance: { sidebar: { showHiddenFiles: false } } };
let mergedConfig: { appearance?: { sidebar?: Record<string, boolean> } } = DEFAULT_MERGED_CONFIG;
let menuActionCallback: ((action: MenuAction) => void) | null = null;

mock.module('@/lib/perf', () => ({
  ProfilerBoundary: PassThrough,
}));

mock.module('@/components/FileTree', () => ({
  FileTree: ({ ref }: { ref?: (handle: unknown) => void }) => {
    useEffect(() => {
      const handle = {
        collapseAll: treeCalls.collapseAll,
        expandAll: treeCalls.expandAll,
        getFolderState: () => ({ folderCount: 2, expandedCount: 1 }),
        isCreationTargetCleared: () => false,
        startCreating: treeCalls.startCreating,
        startCreatingFromTemplate: treeCalls.startCreatingFromTemplate,
        subscribe: () => () => {},
      };
      ref?.(handle);
      return () => ref?.(null);
    }, [ref]);
    return <div data-testid="file-tree-stub" />;
  },
}));

mock.module('@/components/ConflictsSection', () => ({
  ConflictsSection: () => null,
}));

mock.module('@/components/ui/button', () => ({
  Button,
}));

mock.module('@/components/ui/sidebar', () => ({
  Sidebar: ElementPassThrough,
  SidebarContent: ElementPassThrough,
  SidebarFooter: ElementPassThrough,
  SidebarHeader: ElementPassThrough,
  SidebarMenu: ElementPassThrough,
  SidebarMenuItem: ElementPassThrough,
  SidebarGroup: ElementPassThrough,
  SidebarGroupContent: ElementPassThrough,
  SidebarGroupLabel: ElementPassThrough,
  SidebarRail: () => null,
  useSidebar: () => ({ state: 'expanded', toggleSidebar: toggleSidebarMock }),
}));

// FileSidebar renders the Skills section, which pulls in the full sidebar
// primitive set (SidebarMenuButton, SidebarGroup*) plus useSkills. This
// menu-action test is about the file tree's context menu, not skills — stub the
// section so its imports don't need mocking here.
mock.module('@/components/SkillsSidebarSection', () => ({
  SkillsSidebarSection: () => null,
}));

mock.module('@/components/ui/context-menu', () => ({
  ContextMenu: PassThrough,
  ContextMenuCheckboxItem: Button,
  ContextMenuContent: ElementPassThrough,
  ContextMenuItem: Button,
  ContextMenuSeparator: () => <hr />,
  ContextMenuSub: PassThrough,
  ContextMenuSubContent: ElementPassThrough,
  ContextMenuSubTrigger: Button,
  ContextMenuTrigger: PassThrough,
}));

mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: PassThrough,
  DropdownMenuCheckboxItem: ({
    checked,
    children,
    onCheckedChange: _onCheckedChange,
    ...props
  }: {
    checked?: boolean;
    children?: ReactNode;
    onCheckedChange?: (checked: boolean) => void;
    [key: string]: unknown;
  }) => (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked ? 'true' : 'false'}
      {...props}
    >
      {children}
    </button>
  ),
  DropdownMenuContent: ElementPassThrough,
  DropdownMenuGroup: ElementPassThrough,
  DropdownMenuItem: Button,
  DropdownMenuLabel: ElementPassThrough,
  DropdownMenuSeparator: () => null,
  DropdownMenuTrigger: PassThrough,
}));

mock.module('@/components/ui/tooltip', () => ({
  Tooltip: PassThrough,
  TooltipContent: ElementPassThrough,
  TooltipTrigger: PassThrough,
}));

mock.module('@/components/handoff/OpenInAgentEmptySpaceSubmenu', () => ({
  OpenInAgentEmptySpaceSubmenu: () => null,
}));

mock.module('@/components/handoff/useHandoffDispatch', () => ({
  buildFolderHandoffInput: () => ({ docContext: null, docPath: '', folderRelativePath: 'notes' }),
  buildHandoffInput: () => ({
    docContext: { docName: 'notes/source' },
    docPath: 'notes/source.md',
    projectDir: '/tmp/open-knowledge',
  }),
  buildProjectScopedHandoffInput: () => ({
    docContext: null,
    docPath: '',
    projectDir: '/tmp/open-knowledge',
  }),
  useHandoffDispatch: () => ({ dispatch: handoffDispatchMock }),
}));

// Stable across renders like production (`states` is useState state there) —
// a fresh object per render would churn the menu-action effect's
// `handoffInstallStates` dep and re-subscribe on every render.
const installedAgentStates = { codex: { installed: true } };
mock.module('@/components/handoff/useInstalledAgents', () => ({
  useInstalledAgents: () => ({ states: installedAgentStates }),
}));

mock.module('@/components/ProjectSwitcher', () => ({
  ProjectSwitcher: () => null,
}));

mock.module('@/components/SidebarSearchBar', () => ({
  SidebarSearchBar: () => <button type="button">Search</button>,
  onPillRenderError: () => {},
}));

mock.module('@/components/UpdateNotices', () => ({
  UpdateNotices: () => null,
}));

mock.module('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    activeDocName: 'notes/source',
    activeTarget,
  }),
}));

mock.module('@/hooks/use-folder-config', () => ({
  useFolderConfig: () => ({
    state: {
      status: 'ready',
      data: { folder: { templates_available: [] } },
    },
  }),
}));

mock.module('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    projectLocalBinding: projectLocalBindingStub,
    merged: mergedConfig,
  }),
}));

// Stable for the same reason as `installedAgentStates` — `workspace` is a
// dep of the menu-action effect.
const workspaceStub = {
  contentDir: '/tmp/open-knowledge',
  pathSeparator: '/',
};
mock.module('@/lib/use-workspace', () => ({
  useWorkspace: () => workspaceStub,
}));

mock.module('sonner', () => ({
  toast: {
    error: mock(() => {}),
    success: mock(() => {}),
  },
}));

const { FileSidebar } = await import('./FileSidebar');
const {
  subscribeToFileTreeMenuActionDelete,
  subscribeToFileTreeMenuActionDuplicate,
  subscribeToFileTreeMenuActionRename,
} = await import('@/lib/file-tree-menu-action-events');

describe('FileSidebar menu-action runtime routing', () => {
  beforeEach(() => {
    menuActionCallback = null;
    activeTarget = ACTIVE_TARGET;
    mergedConfig = DEFAULT_MERGED_CONFIG;
    for (const fn of [
      notifyViewMenuStateChangedMock,
      toggleSidebarMock,
      showItemInFolderMock,
      handoffDispatchMock,
      projectLocalPatch,
      treeCalls.collapseAll,
      treeCalls.expandAll,
      treeCalls.startCreating,
      treeCalls.startCreatingFromTemplate,
    ]) {
      fn.mockClear();
    }
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: mock(() => Promise.resolve()),
      },
    });
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
        onMenuAction: (callback: (action: MenuAction) => void) => {
          menuActionCallback = callback;
          return () => {
            if (menuActionCallback === callback) menuActionCallback = null;
          };
        },
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

  test('duplicate menu action emits the active target on the FileTree event bus', async () => {
    const received: ResolvedNavigationTarget[] = [];
    const unsubscribe = subscribeToFileTreeMenuActionDuplicate((target) => {
      received.push(target);
    });

    try {
      render(<FileSidebar onOpenSearch={() => {}} />);
      await waitFor(() => expect(menuActionCallback).not.toBeNull());

      menuActionCallback?.('duplicate' as MenuAction);

      expect(received).toEqual([ACTIVE_TARGET]);
    } finally {
      unsubscribe();
    }
  });

  test('toggle-sidebar menu action invokes useSidebar().toggleSidebar()', async () => {
    render(<FileSidebar onOpenSearch={() => {}} />);
    await waitFor(() => expect(menuActionCallback).not.toBeNull());

    menuActionCallback?.('toggle-sidebar' as MenuAction);

    expect(toggleSidebarMock).toHaveBeenCalledTimes(1);
  });

  test('create and tree-state actions route through the FileTree handle', async () => {
    render(<FileSidebar onOpenSearch={() => {}} />);
    await waitFor(() => expect(menuActionCallback).not.toBeNull());

    menuActionCallback?.('new-doc' as MenuAction);
    menuActionCallback?.('new-folder' as MenuAction);
    menuActionCallback?.('new-from-template' as MenuAction);
    menuActionCallback?.('expand-all-tree' as MenuAction);
    menuActionCallback?.('collapse-all-tree' as MenuAction);

    expect(treeCalls.startCreating).toHaveBeenCalledWith('file', 'notes');
    expect(treeCalls.startCreating).toHaveBeenCalledWith('folder', 'notes');
    expect(treeCalls.startCreatingFromTemplate).toHaveBeenCalledWith('notes');
    expect(treeCalls.expandAll).toHaveBeenCalledTimes(1);
    expect(treeCalls.collapseAll).toHaveBeenCalledTimes(1);
  });

  test('rename and move-to-trash menu actions emit the active target on FileTree event buses', async () => {
    const renamed: ResolvedNavigationTarget[] = [];
    const deleted: ResolvedNavigationTarget[] = [];
    const unsubscribeRename = subscribeToFileTreeMenuActionRename((target) => renamed.push(target));
    const unsubscribeDelete = subscribeToFileTreeMenuActionDelete((target) => deleted.push(target));

    try {
      render(<FileSidebar onOpenSearch={() => {}} />);
      await waitFor(() => expect(menuActionCallback).not.toBeNull());

      menuActionCallback?.('rename' as MenuAction);
      menuActionCallback?.('move-to-trash' as MenuAction);

      expect(renamed).toEqual([ACTIVE_TARGET]);
      expect(deleted).toEqual([ACTIVE_TARGET]);
    } finally {
      unsubscribeRename();
      unsubscribeDelete();
    }
  });

  test('mutating menu actions quietly no-op on a revealed .ok folder while create falls back to root', async () => {
    activeTarget = {
      kind: 'folder',
      target: 'notes/.ok/templates',
      folderPath: 'notes/.ok/templates',
    };
    const renamed: ResolvedNavigationTarget[] = [];
    const duplicated: ResolvedNavigationTarget[] = [];
    const deleted: ResolvedNavigationTarget[] = [];
    const unsubscribeRename = subscribeToFileTreeMenuActionRename((target) => renamed.push(target));
    const unsubscribeDuplicate = subscribeToFileTreeMenuActionDuplicate((target) =>
      duplicated.push(target),
    );
    const unsubscribeDelete = subscribeToFileTreeMenuActionDelete((target) => deleted.push(target));

    try {
      render(<FileSidebar onOpenSearch={() => {}} />);
      await waitFor(() => expect(menuActionCallback).not.toBeNull());

      menuActionCallback?.('rename' as MenuAction);
      menuActionCallback?.('duplicate' as MenuAction);
      menuActionCallback?.('move-to-trash' as MenuAction);

      expect(renamed).toEqual([]);
      expect(duplicated).toEqual([]);
      expect(deleted).toEqual([]);

      // Create stays live but re-targets the workspace root; read-only routes
      // keep serving the `.ok` path.
      menuActionCallback?.('new-doc' as MenuAction);
      expect(treeCalls.startCreating).toHaveBeenCalledWith('file', '');

      menuActionCallback?.('copy-relative-path' as MenuAction);
      await waitFor(() =>
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith('notes/.ok/templates'),
      );
    } finally {
      unsubscribeRename();
      unsubscribeDuplicate();
      unsubscribeDelete();
    }
  });

  test('mutating menu actions no-op on an opened .ok asset but stay live for other assets', async () => {
    activeTarget = {
      kind: 'asset',
      target: '.ok/raw-probe.md',
      assetPath: '.ok/raw-probe.md',
      mediaKind: null,
    };
    const renamed: ResolvedNavigationTarget[] = [];
    const deleted: ResolvedNavigationTarget[] = [];
    const unsubscribeRename = subscribeToFileTreeMenuActionRename((target) => renamed.push(target));
    const unsubscribeDelete = subscribeToFileTreeMenuActionDelete((target) => deleted.push(target));

    try {
      const rendered = render(<FileSidebar onOpenSearch={() => {}} />);
      await waitFor(() => expect(menuActionCallback).not.toBeNull());

      menuActionCallback?.('rename' as MenuAction);
      menuActionCallback?.('move-to-trash' as MenuAction);

      expect(renamed).toEqual([]);
      expect(deleted).toEqual([]);

      const imageTarget = {
        kind: 'asset',
        target: 'images/logo.png',
        assetPath: 'images/logo.png',
        mediaKind: 'image',
      } satisfies ResolvedNavigationTarget;
      activeTarget = imageTarget;
      rendered.rerender(<FileSidebar onOpenSearch={() => {}} />);
      await waitFor(() => expect(menuActionCallback).not.toBeNull());

      menuActionCallback?.('rename' as MenuAction);

      expect(renamed).toEqual([imageTarget]);
    } finally {
      unsubscribeRename();
      unsubscribeDelete();
    }
  });

  test('shell, clipboard, handoff, and visibility-toggle actions use runtime dependencies', async () => {
    render(<FileSidebar onOpenSearch={() => {}} />);
    await waitFor(() => expect(menuActionCallback).not.toBeNull());

    menuActionCallback?.('reveal-in-finder' as MenuAction);
    expect(showItemInFolderMock).toHaveBeenCalledWith('/tmp/open-knowledge/notes/source.md');

    menuActionCallback?.('send-to-ai' as MenuAction);
    expect(handoffDispatchMock).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({ docPath: 'notes/source.md' }),
    );

    menuActionCallback?.('copy-full-path' as MenuAction);
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        '/tmp/open-knowledge/notes/source.md',
      ),
    );

    menuActionCallback?.('copy-relative-path' as MenuAction);
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('notes/source.md'),
    );

    menuActionCallback?.('toggle-show-hidden-files' as MenuAction);
    expect(projectLocalPatch).toHaveBeenCalledWith({
      appearance: { sidebar: { showHiddenFiles: true } },
    });

    // The sibling visibility toggles invert their merged-config reads
    // (.ok folders + only-markdown resolve false, skills resolves true in
    // this harness).
    menuActionCallback?.('toggle-show-ok-folders' as MenuAction);
    expect(projectLocalPatch).toHaveBeenCalledWith({
      appearance: { sidebar: { showOkFolders: true } },
    });

    menuActionCallback?.('toggle-show-only-markdown-files' as MenuAction);
    expect(projectLocalPatch).toHaveBeenCalledWith({
      appearance: { sidebar: { showOnlyMarkdownFiles: true } },
    });

    menuActionCallback?.('toggle-show-skills-section' as MenuAction);
    expect(projectLocalPatch).toHaveBeenCalledWith({
      appearance: { sidebar: { showSkillsSection: false } },
    });
  });

  test('visibility toggles read the latest merged config across a flip round-trip', async () => {
    // A native View-menu toggle fires twice in a row: first click patches the
    // inverted default, the CRDT converges the merged config, second click
    // must invert the CONVERGED value — a handler closure that misses the
    // flipped state in its effect deps writes the stale inversion (a no-op)
    // and the menu item sticks in one state.
    const toggleRoundTrips = [
      { action: 'toggle-show-hidden-files', key: 'showHiddenFiles', defaultValue: false },
      { action: 'toggle-show-ok-folders', key: 'showOkFolders', defaultValue: false },
      {
        action: 'toggle-show-only-markdown-files',
        key: 'showOnlyMarkdownFiles',
        defaultValue: false,
      },
      { action: 'toggle-show-skills-section', key: 'showSkillsSection', defaultValue: true },
    ] as const;

    const { rerender } = render(<FileSidebar onOpenSearch={() => {}} />);
    await waitFor(() => expect(menuActionCallback).not.toBeNull());

    for (const { action, key, defaultValue } of toggleRoundTrips) {
      mergedConfig = { appearance: { sidebar: {} } };
      rerender(<FileSidebar onOpenSearch={() => {}} />);

      projectLocalPatch.mockClear();
      menuActionCallback?.(action as MenuAction);
      expect(projectLocalPatch).toHaveBeenCalledWith({
        appearance: { sidebar: { [key]: !defaultValue } },
      });

      // Converge: the merged config now reflects the patched value.
      mergedConfig = { appearance: { sidebar: { [key]: !defaultValue } } };
      rerender(<FileSidebar onOpenSearch={() => {}} />);

      projectLocalPatch.mockClear();
      menuActionCallback?.(action as MenuAction);
      expect(projectLocalPatch).toHaveBeenCalledWith({
        appearance: { sidebar: { [key]: defaultValue } },
      });
    }
  });

  test('pushes View menu state to the desktop bridge with merged visibility and tree gates', async () => {
    render(<FileSidebar onOpenSearch={() => {}} />);

    await waitFor(() =>
      expect(notifyViewMenuStateChangedMock).toHaveBeenCalledWith(
        expect.objectContaining({
          canCollapseAll: true,
          canExpandAll: true,
          showHiddenFiles: false,
          showOnlyMarkdownFiles: false,
          showSkillsSection: true,
          sidebarVisible: true,
        }),
      ),
    );
  });
});
