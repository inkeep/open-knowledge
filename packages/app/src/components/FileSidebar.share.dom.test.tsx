import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';

// Controls the mocked git-sync hook's hasRemote signal per test.
let hasRemote = true;
// Captures the input runShareAction receives.
let lastShareInput: unknown;
const runShareActionMock = mock(async (input: unknown) => {
  lastShareInput = input;
  return { kind: 'copied' as const, shareUrl: 'https://example.test/x', branch: 'main' };
});

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
  onCheckedChange,
  onSelect,
  checked,
  size: _size,
  variant: _variant,
  ...props
}: {
  children?: ReactNode;
  asChild?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  onSelect?: () => void;
  checked?: boolean;
  size?: unknown;
  variant?: unknown;
  [key: string]: unknown;
}) {
  // Radix menu items dispatch via onSelect; map it to onClick for the test.
  return (
    <button
      type="button"
      onClick={() => {
        onCheckedChange?.(!checked);
        onSelect?.();
      }}
      {...props}
    >
      {children}
    </button>
  );
}

mock.module('@/lib/perf', () => ({ ProfilerBoundary: PassThrough }));

mock.module('@/components/FileTree', () => ({
  FileTree: () => <div data-testid="file-tree-stub" />,
}));

mock.module('@/components/ConflictsSection', () => ({ ConflictsSection: () => null }));

mock.module('@/hooks/use-git-sync-status', () => ({
  useGitSyncStatusDetailed: () => ({
    status: { hasRemote, syncEnabled: hasRemote, behind: 0, ahead: 0 },
    fetchError: null,
  }),
  useGitSyncStatus: () => ({ hasRemote, syncEnabled: hasRemote, behind: 0, ahead: 0 }),
}));

mock.module('@/lib/share/clipboard-adapter', () => ({
  scheduleClipboardWrite: async () => {},
}));

mock.module('@/lib/share/run-share-action', () => ({
  buildFolderShareInput: (folderRelativePath: string) => ({ kind: 'folder', folderRelativePath }),
  runShareAction: runShareActionMock,
}));

mock.module('@/components/ui/button', () => ({ Button }));

mock.module('@/components/ui/collapsible', () => ({
  Collapsible: ({ children, defaultOpen: _defaultOpen, ...props }: Record<string, unknown>) => (
    <div {...props}>{children as ReactNode}</div>
  ),
  CollapsibleContent: ElementPassThrough,
  CollapsibleTrigger: Button,
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
  useSidebar: () => ({ state: 'expanded', toggleSidebar: () => {} }),
}));

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
  DropdownMenuContent: ElementPassThrough,
  DropdownMenuItem: Button,
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
  buildFolderHandoffInput: () => null,
  buildHandoffInput: () => null,
  buildProjectScopedHandoffInput: () => ({ docContext: null, docPath: '', projectDir: '/tmp/ok' }),
  useHandoffDispatch: () => ({ dispatch: async () => ({ ok: true as const }) }),
}));

mock.module('@/components/handoff/useInstalledAgents', () => ({
  useInstalledAgents: () => ({ states: {} }),
}));

mock.module('@/components/ProjectSwitcher', () => ({ ProjectSwitcher: () => null }));

mock.module('@/components/SidebarSearchBar', () => ({
  SidebarSearchBar: () => <button type="button">Search</button>,
  onPillRenderError: () => {},
}));

mock.module('@/components/UpdateNotices', () => ({ UpdateNotices: () => null }));

mock.module('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    activeDocName: 'notes/source',
    activeTarget: { kind: 'doc', target: 'notes/source', docName: 'notes/source' },
  }),
}));

mock.module('@/hooks/use-folder-config', () => ({
  useFolderConfig: () => ({
    state: { status: 'ready', data: { folder: { templates_available: [] } } },
  }),
}));

mock.module('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    projectLocalBinding: { patch: () => ({ ok: true as const }) },
    merged: { appearance: { sidebar: { showHiddenFiles: false } } },
  }),
}));

mock.module('@/lib/use-workspace', () => ({
  useWorkspace: () => ({ contentDir: '/tmp/open-knowledge', pathSeparator: '/' }),
}));

mock.module('sonner', () => ({
  toast: { error: mock(() => {}), success: mock(() => {}) },
}));

const { FileSidebar } = await import('./FileSidebar');

describe('FileSidebar project-root Share', () => {
  beforeEach(() => {
    hasRemote = true;
    lastShareInput = undefined;
    runShareActionMock.mockClear();
    // Web mode (no okDesktop) keeps the test off the Electron header path.
    Object.defineProperty(window, 'okDesktop', { configurable: true, value: undefined });
  });

  afterEach(() => {
    cleanup();
  });

  test('the project-root header is marked so right-clicks open the project menu', async () => {
    render(<FileSidebar onOpenSearch={() => {}} />);
    const header = await screen.findByText('open-knowledge');
    // The header (or an ancestor) carries the right-click-exemption marker.
    expect(header.closest('[data-sidebar-root-context]')).not.toBeNull();
  });

  test('empty-space menu shows Share and dispatches a root-scope share input', async () => {
    const user = userEvent.setup();
    render(<FileSidebar onOpenSearch={() => {}} />);

    const share = await screen.findByTestId('empty-space-menu-share');
    await user.click(share);

    expect(runShareActionMock).toHaveBeenCalledTimes(1);
    expect(lastShareInput).toMatchObject({
      kind: 'folder',
      folderRelativePath: '',
      hasRemote: true,
    });
  });

  test('Share is hidden when the project has no GitHub remote', async () => {
    hasRemote = false;
    render(<FileSidebar onOpenSearch={() => {}} />);

    // Another always-present root item proves the menu rendered.
    await screen.findByTestId('empty-space-menu-new-file');
    expect(screen.queryByTestId('empty-space-menu-share')).toBeNull();
  });
});
