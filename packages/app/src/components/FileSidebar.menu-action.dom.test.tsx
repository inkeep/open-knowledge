import { cleanup, render, waitFor } from '@testing-library/react';
import { type ReactNode, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { __resetSkillsSectionVisibleCacheForTests } from '@/components/skills-section-visible-cache';
import { TooltipProvider } from '@/components/ui/tooltip';
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

const notifyViewMenuStateChangedMock = vi.fn(() => {});
const toggleSidebarMock = vi.fn(() => {});
const showItemInFolderMock = vi.fn((_path: string) => Promise.resolve());
const handoffDispatchMock = vi.fn((_target: string, _input: unknown) =>
  Promise.resolve({ ok: true }),
);
const treeCalls = {
  collapseAll: vi.fn(() => {}),
  expandAll: vi.fn(() => {}),
  startCreating: vi.fn((_kind: 'file' | 'folder', _parentDir: string) => {}),
  startCreatingFromTemplate: vi.fn((_parentDir: string) => {}),
};
const projectLocalPatch = vi.fn((_patch: unknown) => ({ ok: true as const }));
const projectLocalBindingStub = { patch: projectLocalPatch };
const DEFAULT_MERGED_CONFIG = { appearance: { sidebar: { showHiddenFiles: false } } };
let mergedConfig: { appearance?: { sidebar?: Record<string, boolean> } } = DEFAULT_MERGED_CONFIG;
let menuActionCallback: ((action: MenuAction) => void) | null = null;

vi.doMock('@/lib/perf', () => ({
  ProfilerBoundary: PassThrough,
}));

vi.doMock('@/components/FileTree', () => ({
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

vi.doMock('@/components/ConflictsSection', () => ({
  ConflictsSection: () => null,
}));

vi.doMock('@/components/ui/button', () => ({
  Button,
}));

vi.doMock('@/components/ui/sidebar', () => ({
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

vi.doMock('@/components/SkillsSidebarSection', () => ({
  SkillsSidebarSection: () => null,
}));

vi.doMock('@/components/ui/context-menu', () => ({
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

vi.doMock('@/components/ui/dropdown-menu', () => ({
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

vi.doMock('@/components/handoff/OpenInAgentEmptySpaceSubmenu', () => ({
  OpenInAgentEmptySpaceSubmenu: () => null,
}));

const threadLaunchMock = vi.fn(
  (_input: unknown, _opts?: { agent?: { source: string; id: string } }) => {},
);
const openInstallUrlMock = vi.fn((_target: unknown) => Promise.resolve());
vi.doMock('@/components/handoff/useHandoffDispatch', () => ({
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
  openInstallUrl: openInstallUrlMock,
  startAgentThreadForInput: threadLaunchMock,
  useHandoffDispatch: () => ({ dispatch: handoffDispatchMock }),
}));

const installedAgentStates = { codex: { installed: true } };
const noAgentStates = {
  'claude-code': { installed: false },
  'claude-cowork': { installed: false },
  codex: { installed: false },
  cursor: { installed: false },
};
let noAgentsInstalled = false;
vi.doMock('@/components/handoff/useInstalledAgents', () => ({
  useInstalledAgents: () => ({ states: noAgentsInstalled ? noAgentStates : installedAgentStates }),
}));

vi.doMock('@/components/ProjectSwitcher', () => ({
  ProjectSwitcher: () => null,
}));

vi.doMock('@/components/SidebarSearchBar', () => ({
  SidebarSearchBar: () => <button type="button">Search</button>,
  onPillRenderError: () => {},
}));

vi.doMock('@/components/UpdateNotices', () => ({
  UpdateNotices: () => null,
}));

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    activeDocName: 'notes/source',
    activeTarget,
  }),
  isBlobRunnerNewTabId: () => false,
}));

vi.doMock('@/hooks/use-folder-config', () => ({
  useFolderConfig: () => ({
    state: {
      status: 'ready',
      data: { folder: { templates_available: [] } },
    },
  }),
}));

vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    projectLocalBinding: projectLocalBindingStub,
    merged: mergedConfig,
  }),
}));

const workspaceStub = {
  contentDir: '/tmp/open-knowledge',
  pathSeparator: '/',
};
vi.doMock('@/lib/use-workspace', () => ({
  useWorkspace: () => workspaceStub,
}));

const toastInfoMock = vi.fn((_msg: string) => {});
const toastErrorMock = vi.fn((_msg: string) => {});
vi.doMock('sonner', () => ({
  toast: {
    error: toastErrorMock,
    info: toastInfoMock,
    success: vi.fn(() => {}),
  },
}));

const { FileSidebar } = await import('./FileSidebar');
const {
  subscribeToFileTreeMenuActionDelete,
  subscribeToFileTreeMenuActionDuplicate,
  subscribeToFileTreeMenuActionRename,
} = await import('@/lib/file-tree-menu-action-events');
const { reloadEnabledAgentsFromStorage } = await import('@/lib/acp/enabled-agents');
const { registerAgent, reloadRegisteredAgentsFromStorage } = await import(
  '@/lib/acp/registered-agents'
);
const { saveStickyAgent } = await import('@/lib/unified-agent-store');

function renderSidebar() {
  return render(<FileSidebar onOpenSearch={() => {}} />, { wrapper: TooltipProvider });
}

describe('FileSidebar menu-action runtime routing', () => {
  beforeEach(() => {
    menuActionCallback = null;
    activeTarget = ACTIVE_TARGET;
    mergedConfig = DEFAULT_MERGED_CONFIG;
    noAgentsInstalled = false;
    __resetSkillsSectionVisibleCacheForTests();
    if (typeof localStorage !== 'undefined') localStorage.clear();
    reloadRegisteredAgentsFromStorage();
    reloadEnabledAgentsFromStorage();
    for (const fn of [
      notifyViewMenuStateChangedMock,
      toggleSidebarMock,
      showItemInFolderMock,
      handoffDispatchMock,
      threadLaunchMock,
      openInstallUrlMock,
      toastInfoMock,
      toastErrorMock,
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
        writeText: vi.fn(() => Promise.resolve()),
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
      renderSidebar();
      await waitFor(() => expect(menuActionCallback).not.toBeNull());

      menuActionCallback?.('duplicate' as MenuAction);

      expect(received).toEqual([ACTIVE_TARGET]);
    } finally {
      unsubscribe();
    }
  });

  test('toggle-sidebar menu action invokes useSidebar().toggleSidebar()', async () => {
    renderSidebar();
    await waitFor(() => expect(menuActionCallback).not.toBeNull());

    menuActionCallback?.('toggle-sidebar' as MenuAction);

    expect(toggleSidebarMock).toHaveBeenCalledTimes(1);
  });

  test('create and tree-state actions route through the FileTree handle', async () => {
    renderSidebar();
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
      renderSidebar();
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
      renderSidebar();
      await waitFor(() => expect(menuActionCallback).not.toBeNull());

      menuActionCallback?.('rename' as MenuAction);
      menuActionCallback?.('duplicate' as MenuAction);
      menuActionCallback?.('move-to-trash' as MenuAction);

      expect(renamed).toEqual([]);
      expect(duplicated).toEqual([]);
      expect(deleted).toEqual([]);

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
      const rendered = renderSidebar();
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

  test('send-to-ai prefers an enabled in-app agent over an installed external app', async () => {
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    renderSidebar();
    await waitFor(() => expect(menuActionCallback).not.toBeNull());

    menuActionCallback?.('send-to-ai' as MenuAction);

    expect(threadLaunchMock).toHaveBeenCalledWith(
      expect.objectContaining({ docPath: 'notes/source.md' }),
      { agent: { source: 'registry', id: 'claude-acp' } },
    );
    expect(handoffDispatchMock).not.toHaveBeenCalled();
  });

  test('send-to-ai still honors an explicit saved external-app choice', async () => {
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    saveStickyAgent('codex');
    renderSidebar();
    await waitFor(() => expect(menuActionCallback).not.toBeNull());

    menuActionCallback?.('send-to-ai' as MenuAction);

    expect(handoffDispatchMock).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({ docPath: 'notes/source.md' }),
    );
    expect(threadLaunchMock).not.toHaveBeenCalled();
  });

  test('send-to-ai sends an uninstalled saved external app to its installer and says so', async () => {
    saveStickyAgent('claude-code');
    renderSidebar();
    await waitFor(() => expect(menuActionCallback).not.toBeNull());

    menuActionCallback?.('send-to-ai' as MenuAction);

    expect(openInstallUrlMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'claude-code' }));
    expect(handoffDispatchMock).not.toHaveBeenCalled();
    expect(threadLaunchMock).not.toHaveBeenCalled();
    expect(toastInfoMock).toHaveBeenCalledTimes(1);
    expect(String(toastInfoMock.mock.calls[0]?.[0])).toContain("isn't installed yet");
  });

  test('send-to-ai reports when no route is available at all', async () => {
    noAgentsInstalled = true;
    renderSidebar();
    await waitFor(() => expect(menuActionCallback).not.toBeNull());

    menuActionCallback?.('send-to-ai' as MenuAction);

    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(handoffDispatchMock).not.toHaveBeenCalled();
    expect(threadLaunchMock).not.toHaveBeenCalled();
    expect(openInstallUrlMock).not.toHaveBeenCalled();
  });

  test('shell, clipboard, handoff, and visibility-toggle actions use runtime dependencies', async () => {
    renderSidebar();
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

    const { rerender } = renderSidebar();
    await waitFor(() => expect(menuActionCallback).not.toBeNull());

    for (const { action, key, defaultValue } of toggleRoundTrips) {
      mergedConfig = { appearance: { sidebar: {} } };
      rerender(<FileSidebar onOpenSearch={() => {}} />);

      projectLocalPatch.mockClear();
      menuActionCallback?.(action as MenuAction);
      expect(projectLocalPatch).toHaveBeenCalledWith({
        appearance: { sidebar: { [key]: !defaultValue } },
      });

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
    renderSidebar();

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
