import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Controls the mocked git-sync hook's hasRemote signal per test.
let hasRemote = true;
// Captures the input runShareAction receives.
let lastShareInput: unknown;
const runShareActionMock = vi.fn(async (input: unknown) => {
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

vi.doMock('@/lib/perf', () => ({ ProfilerBoundary: PassThrough }));

vi.doMock('@/components/FileTree', () => ({
  FileTree: () => <div data-testid="file-tree-stub" />,
}));

vi.doMock('@/components/ConflictsSection', () => ({ ConflictsSection: () => null }));

vi.doMock('@/hooks/use-git-sync-status', () => ({
  useGitSyncStatusDetailed: () => ({
    status: { hasRemote, syncEnabled: hasRemote, behind: 0, ahead: 0 },
    fetchError: null,
  }),
  useGitSyncStatus: () => ({ hasRemote, syncEnabled: hasRemote, behind: 0, ahead: 0 }),
}));

vi.doMock('@/lib/share/clipboard-adapter', () => ({
  scheduleClipboardWrite: async () => {},
}));

vi.doMock('@/lib/share/run-share-action', () => ({
  buildFolderShareInput: (folderRelativePath: string) => ({ kind: 'folder', folderRelativePath }),
  runShareAction: runShareActionMock,
}));

vi.doMock('@/components/ui/button', () => ({ Button }));

vi.doMock('@/components/ui/collapsible', () => ({
  Collapsible: ({ children, defaultOpen: _defaultOpen, ...props }: Record<string, unknown>) => (
    <div {...props}>{children as ReactNode}</div>
  ),
  CollapsibleContent: ElementPassThrough,
  CollapsibleTrigger: Button,
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
  useSidebar: () => ({ state: 'expanded', toggleSidebar: () => {} }),
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

vi.doMock('@/components/ui/tooltip', () => ({
  Tooltip: PassThrough,
  TooltipContent: ElementPassThrough,
  TooltipTrigger: PassThrough,
}));

vi.doMock('@/components/handoff/OpenInAgentEmptySpaceSubmenu', () => ({
  OpenInAgentEmptySpaceSubmenu: () => null,
}));

vi.doMock('@/components/handoff/useHandoffDispatch', () => ({
  buildFolderHandoffInput: () => null,
  buildHandoffInput: () => null,
  buildProjectScopedHandoffInput: () => ({ docContext: null, docPath: '', projectDir: '/tmp/ok' }),
  useHandoffDispatch: () => ({ dispatch: async () => ({ ok: true as const }) }),
}));

vi.doMock('@/components/handoff/useInstalledAgents', () => ({
  useInstalledAgents: () => ({ states: {} }),
}));

vi.doMock('@/components/ProjectSwitcher', () => ({ ProjectSwitcher: () => null }));

vi.doMock('@/components/SidebarSearchBar', () => ({
  SidebarSearchBar: () => <button type="button">Search</button>,
  onPillRenderError: () => {},
}));

vi.doMock('@/components/UpdateNotices', () => ({ UpdateNotices: () => null }));

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    activeDocName: 'notes/source',
    activeTarget: { kind: 'doc', target: 'notes/source', docName: 'notes/source' },
  }),
}));

vi.doMock('@/hooks/use-folder-config', () => ({
  useFolderConfig: () => ({
    state: { status: 'ready', data: { folder: { templates_available: [] } } },
  }),
}));

vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    projectLocalBinding: { patch: () => ({ ok: true as const }) },
    merged: { appearance: { sidebar: { showHiddenFiles: false } } },
  }),
}));

vi.doMock('@/lib/use-workspace', () => ({
  useWorkspace: () => ({ contentDir: '/tmp/open-knowledge', pathSeparator: '/' }),
}));

vi.doMock('sonner', () => ({
  toast: { error: vi.fn(() => {}), success: vi.fn(() => {}) },
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
