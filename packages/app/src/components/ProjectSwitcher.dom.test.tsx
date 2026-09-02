import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createContext, type ReactNode, use } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  __resetLocalMenuActionBusForTests,
  emitLocalMenuAction,
} from '@/lib/local-menu-action-bus';

type MenuProps = {
  children?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};
type ItemProps = {
  children?: ReactNode;
  disabled?: boolean;
  onSelect?: () => void;
  [key: string]: unknown;
};

let lastDropdownOpenChange: ((open: boolean) => void) | null = null;
let keydownBubbleCount = 0;
let createDialogProps: Array<{ open: boolean; bridge: unknown }> = [];

const SubStateContext = createContext<{ open: boolean; onOpenChange: (o: boolean) => void }>({
  open: false,
  onOpenChange: () => {},
});
vi.doMock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children, onOpenChange }: MenuProps) => {
    lastDropdownOpenChange = onOpenChange ?? null;
    return <div>{children}</div>;
  },
  DropdownMenuContent: ({ children, ...props }: ItemProps) => (
    <div role="menu" {...props}>
      {children}
    </div>
  ),
  DropdownMenuItem: ({ children, disabled, onSelect, ...props }: ItemProps) => (
    <button type="button" role="menuitem" disabled={disabled} onClick={onSelect} {...props}>
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children, ...props }: ItemProps) => <div {...props}>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuPortal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuSub: ({ children, open, onOpenChange }: MenuProps) => (
    <SubStateContext value={{ open: !!open, onOpenChange: onOpenChange ?? (() => {}) }}>
      {children}
    </SubStateContext>
  ),
  DropdownMenuSubTrigger: ({
    children,
    onClick,
    onKeyDown,
    ...props
  }: ItemProps & {
    onClick?: (e: React.MouseEvent) => void;
    onKeyDown?: (e: React.KeyboardEvent) => void;
  }) => {
    const { onOpenChange } = use(SubStateContext);
    return (
      <div
        role="menuitem"
        tabIndex={-1}
        onMouseEnter={() => onOpenChange(true)}
        onClick={(e) => {
          onClick?.(e);
          if (!e.defaultPrevented) onOpenChange(true);
        }}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') onOpenChange(true);
          else if (e.key === 'ArrowLeft' || e.key === 'Escape') onOpenChange(false);
        }}
        {...props}
      >
        {children}
      </div>
    );
  },
  DropdownMenuSubContent: ({
    children,
    sideOffset: _sideOffset,
    avoidCollisions: _avoidCollisions,
    ...props
  }: ItemProps) => {
    const { open } = use(SubStateContext);
    if (!open) return null;
    return <div {...props}>{children}</div>;
  },
}));

vi.doMock('@/components/ui/input-group', () => ({
  InputGroup: ({ children, ...props }: ItemProps) => (
    <fieldset
      {...props}
      onKeyDown={() => {
        keydownBubbleCount += 1;
      }}
    >
      {children}
    </fieldset>
  ),
  InputGroupAddon: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  InputGroupInput: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.doMock('@/components/ui/sidebar', () => ({
  SidebarMenuButton: ({ children, ...props }: ItemProps) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.doMock('./CreateProjectDialog', () => ({
  CreateProjectDialog: (props: { open: boolean; bridge: unknown }) => {
    createDialogProps.push(props);
    return <div data-testid="create-project-dialog" data-open={String(props.open)} />;
  },
}));

let newWorktreeProps: Array<{
  open: boolean;
  branches?: readonly string[];
  existingWorktreeBranches?: ReadonlySet<string>;
  remoteBranches?: readonly string[];
  behindByBranch?: ReadonlyMap<string, number>;
  initialBranchName?: string;
}> = [];
vi.doMock('./NewWorktreeDialog', () => ({
  NewWorktreeDialog: (props: {
    open: boolean;
    branches?: readonly string[];
    existingWorktreeBranches?: ReadonlySet<string>;
    remoteBranches?: readonly string[];
    behindByBranch?: ReadonlyMap<string, number>;
    initialBranchName?: string;
  }) => {
    newWorktreeProps.push(props);
    return (
      <div
        data-testid="new-worktree-dialog"
        data-open={String(props.open)}
        data-initial-name={props.initialBranchName ?? ''}
      />
    );
  },
}));

vi.doMock('@/hooks/use-current-branch', () => ({
  useCurrentBranch: () => 'main',
}));
vi.doMock('@/hooks/use-worktrees', () => ({
  useWorktrees: () => ({
    mainRoot: '/projects/current',
    currentBranch: 'main',
    entries: [
      {
        branch: 'omega-branch',
        worktreePath: null,
        isCurrent: false,
        isMain: false,
        locked: false,
        behind: 4,
      },
      {
        branch: 'has-worktree',
        worktreePath: '/projects/current/.ok/worktrees/has-worktree',
        isCurrent: false,
        isMain: false,
        locked: false,
        behind: 0,
      },
    ],
    remoteBranches: ['origin/main', 'origin/omega-branch', 'origin/remote-only-x'],
  }),
}));

function recent(name: string, path = `/projects/${name.toLowerCase()}`) {
  return { name, path: path.replaceAll(' ', '-') };
}

function createBridge() {
  return {
    config: {
      projectName: 'Current Project',
      projectPath: '/projects/current',
    },
    project: {
      listRecent: vi.fn(() =>
        Promise.resolve([
          recent('Current', '/projects/current'),
          ...Array.from({ length: 10 }, (_, index) => recent(`Project ${index + 1}`)),
          recent('Omega', '/archive/omega-project'),
          {
            name: 'omega-wt',
            path: '/archive/omega-wt',
            branch: 'omega-branch',
            isLinkedWorktree: true,
            mainRoot: '/archive/omega-project',
          },
        ]),
      ),
      open: vi.fn(() => Promise.resolve()),
      openFile: vi.fn(() => Promise.resolve()),
    },
    dialog: {
      openFolder: vi.fn(() => Promise.resolve('/chosen/folder')),
    },
    navigator: {
      open: vi.fn(() => Promise.resolve()),
    },
    worktree: {
      list: vi.fn(() => Promise.resolve({ ok: false as const, reason: 'no-git' as const })),
      create: vi.fn(() => Promise.resolve({ ok: false as const, reason: 'no-git' as const })),
    },
    onMenuAction: vi.fn(() => () => {}),
  };
}

async function openMenu() {
  fireEvent.click(screen.getByTestId('project-switcher-trigger'));
  act(() => {
    lastDropdownOpenChange?.(true);
  });
  await waitFor(() => {
    expect(screen.getByTestId('project-switcher-search')).not.toBeNull();
  });
}

const { ProjectSwitcher } = await import('./ProjectSwitcher');

describe('ProjectSwitcher dropdown behavior', () => {
  beforeEach(() => {
    cleanup();
    lastDropdownOpenChange = null;
    keydownBubbleCount = 0;
    createDialogProps = [];
    newWorktreeProps = [];
    __resetLocalMenuActionBusForTests();
    (window as unknown as { okDesktop?: unknown }).okDesktop = undefined;
  });

  test('renders footer actions in order and routes each action through the expected bridge entry point', async () => {
    const bridge = createBridge();
    render(<ProjectSwitcher bridge={bridge as never} />);

    expect(screen.getByTestId('project-switcher-trigger').textContent).toContain('Current Project');

    await openMenu();

    const menuText = screen.getByTestId('project-switcher-menu').textContent ?? '';
    const newProjectIndex = menuText.indexOf('New project');
    const switchProjectIndex = menuText.indexOf('Switch project');
    const openFolderIndex = menuText.indexOf('Open folder');
    const newWorktreeIndex = menuText.indexOf('New worktree');
    expect(newProjectIndex).toBeGreaterThan(-1);
    expect(switchProjectIndex).toBeGreaterThan(newProjectIndex);
    expect(openFolderIndex).toBeGreaterThan(switchProjectIndex);
    expect(newWorktreeIndex).toBeGreaterThan(openFolderIndex);

    for (const testId of [
      'project-switcher-new-project',
      'project-switcher-switch-project',
      'project-switcher-open-folder',
      'project-switcher-open-file',
    ]) {
      expect(screen.getByTestId(testId).querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    }

    fireEvent.click(screen.getByTestId('project-switcher-switch-project'));
    await waitFor(() => expect(bridge.navigator.open).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('project-switcher-open-folder'));
    await waitFor(() => {
      expect(bridge.project.open).toHaveBeenCalledWith({
        path: '/chosen/folder',
        target: 'new-window',
        entryPoint: 'pick-existing',
      });
    });

    fireEvent.click(screen.getByTestId('project-switcher-open-file'));
    await waitFor(() => expect(bridge.project.openFile).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('project-switcher-recent-/projects/project-1'));
    await waitFor(() => {
      expect(bridge.project.open).toHaveBeenCalledWith({
        path: '/projects/project-1',
        target: 'new-window',
        entryPoint: 'recents',
      });
    });

    fireEvent.click(screen.getByTestId('project-switcher-new-project'));
    await waitFor(() => {
      expect(screen.getByTestId('create-project-dialog').getAttribute('data-open')).toBe('true');
    });
    expect(createDialogProps.at(-1)?.bridge).toBe(bridge);
  });

  test('the per-row × removes a recent from the list without opening it', async () => {
    const bridge = createBridge();
    bridge.project.removeRecent = vi.fn(() => Promise.resolve());
    render(<ProjectSwitcher bridge={bridge as never} />);
    await openMenu();

    fireEvent.click(screen.getByTestId('project-switcher-recent-remove-/projects/project-1'));
    await waitFor(() => {
      expect(bridge.project.removeRecent).toHaveBeenCalledWith('/projects/project-1');
    });
    expect(bridge.project.open).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByTestId('project-switcher-recent-/projects/project-1')).toBeNull();
    });
  });

  test('search matches projects only (not worktrees/branches), announces empty results, stops typeahead bubbling, and clears on close', async () => {
    const bridge = createBridge();
    render(<ProjectSwitcher bridge={bridge as never} />);

    await openMenu();

    const search = screen.getByTestId('project-switcher-search') as HTMLInputElement;
    expect(search.placeholder).toBe('Search projects...');
    expect(search.getAttribute('aria-label')).toBe('Search projects');

    fireEvent.keyDown(search, { key: 'O' });
    expect(keydownBubbleCount).toBe(0);

    fireEvent.change(search, { target: { value: 'omega' } });

    await waitFor(() => {
      expect(screen.getByTestId('project-switcher-recent-/archive/omega-project')).not.toBeNull();
    });
    expect(screen.queryByTestId('project-switcher-recent-/projects/project-1')).toBeNull();
    expect(screen.queryByTestId('project-switcher-worktree-/archive/omega-wt')).toBeNull();
    expect(screen.queryByTestId('project-switcher-branch-omega-branch')).toBeNull();

    fireEvent.change(search, { target: { value: 'does-not-exist' } });

    expect((await screen.findByRole('status')).textContent).toBe('No matching projects.');

    act(() => {
      lastDropdownOpenChange?.(false);
      lastDropdownOpenChange?.(true);
    });

    await waitFor(() => {
      expect((screen.getByTestId('project-switcher-search') as HTMLInputElement).value).toBe('');
    });
  });

  test('the top-level "New worktree…" item opens the New Worktree dialog EMPTY (no pre-fill)', async () => {
    const bridge = createBridge();
    render(<ProjectSwitcher bridge={bridge as never} />);
    await openMenu();

    fireEvent.click(screen.getByTestId('project-switcher-new-worktree'));
    const dialog = await waitFor(() => {
      const el = screen.getByTestId('new-worktree-dialog');
      expect(el.getAttribute('data-open')).toBe('true');
      return el;
    });
    expect(dialog.getAttribute('data-initial-name')).toBe('');
    expect(newWorktreeProps.at(-1)?.initialBranchName).toBe('');
  });

  test('the flyout "Create worktree …" action opens the dialog PRE-FILLED with the typed name', async () => {
    const bridge = createBridge();
    bridge.project.listRecent = vi.fn(() =>
      Promise.resolve([
        {
          name: 'current',
          path: '/projects/current',
          gitCommonDir: '/projects/current/.git',
          mainRoot: '/projects/current',
          isLinkedWorktree: false,
          branch: 'main',
          lastOpenedAt: '2026-07-01',
        },
        {
          name: 'has-worktree',
          path: '/projects/current/.ok/worktrees/has-worktree',
          gitCommonDir: '/projects/current/.git',
          mainRoot: '/projects/current',
          isLinkedWorktree: true,
          branch: 'has-worktree',
          lastOpenedAt: '2026-07-01',
        },
      ]),
    );
    render(<ProjectSwitcher bridge={bridge as never} />);
    await openMenu();

    fireEvent.mouseEnter(screen.getByTestId('project-switcher-group-/projects/current'));
    const searchBox = (await screen.findByTestId(
      'project-switcher-flyout-search-/projects/current',
    )) as HTMLInputElement;
    fireEvent.change(searchBox, { target: { value: 'shiny-feature' } });

    const createOption = await screen.findByTestId('project-switcher-flyout-create');
    fireEvent.click(createOption);

    const dialog = await waitFor(() => {
      const el = screen.getByTestId('new-worktree-dialog');
      expect(el.getAttribute('data-open')).toBe('true');
      return el;
    });
    expect(dialog.getAttribute('data-initial-name')).toBe('shiny-feature');
    expect(newWorktreeProps.at(-1)?.initialBranchName).toBe('shiny-feature');
  });

  test('scrolling the recents list closes an open worktree flyout (submenu does not follow the row off-screen)', async () => {
    const bridge = createBridge();
    bridge.project.listRecent = vi.fn(() =>
      Promise.resolve([
        {
          name: 'current',
          path: '/projects/current',
          gitCommonDir: '/projects/current/.git',
          mainRoot: '/projects/current',
          isLinkedWorktree: false,
          branch: 'main',
          lastOpenedAt: '2026-07-01',
        },
        {
          name: 'has-worktree',
          path: '/projects/current/.ok/worktrees/has-worktree',
          gitCommonDir: '/projects/current/.git',
          mainRoot: '/projects/current',
          isLinkedWorktree: true,
          branch: 'has-worktree',
          lastOpenedAt: '2026-07-01',
        },
      ]),
    );
    render(<ProjectSwitcher bridge={bridge as never} />);
    await openMenu();

    fireEvent.mouseEnter(screen.getByTestId('project-switcher-group-/projects/current'));
    await screen.findByTestId('project-switcher-flyout-/projects/current');

    fireEvent.scroll(screen.getByTestId('project-switcher-scroll'));
    await waitFor(() => {
      expect(screen.queryByTestId('project-switcher-flyout-/projects/current')).toBeNull();
    });
  });

  test('threads branches and the already-has-a-worktree set from the cached model to the dialog', async () => {
    const bridge = createBridge();
    render(<ProjectSwitcher bridge={bridge as never} />);
    await openMenu();

    fireEvent.click(screen.getByTestId('project-switcher-new-worktree'));
    await waitFor(() =>
      expect(screen.getByTestId('new-worktree-dialog').getAttribute('data-open')).toBe('true'),
    );

    const props = newWorktreeProps.at(-1);
    expect(props?.branches).toContain('omega-branch');
    expect(props?.branches).toContain('has-worktree');
    expect(props?.existingWorktreeBranches?.has('has-worktree')).toBe(true);
    expect(props?.existingWorktreeBranches?.has('omega-branch')).toBe(false);
    expect(props?.remoteBranches).toEqual([
      'origin/main',
      'origin/omega-branch',
      'origin/remote-only-x',
    ]);
    expect(props?.behindByBranch?.get('omega-branch')).toBe(4);
    expect(props?.behindByBranch?.get('has-worktree')).toBe(0);
  });

  test('File menu "new-worktree" action opens the New Worktree dialog; "switch-worktree" opens the dropdown', async () => {
    const bridge = createBridge();
    render(<ProjectSwitcher bridge={bridge as never} />);

    act(() => emitLocalMenuAction('new-worktree'));
    await waitFor(() =>
      expect(screen.getByTestId('new-worktree-dialog').getAttribute('data-open')).toBe('true'),
    );

    act(() => emitLocalMenuAction('switch-worktree'));
    await waitFor(() => {
      expect(screen.getByTestId('project-switcher-search')).not.toBeNull();
    });
  });

  test('on the Electron host, a row selection within the open-click guard window is swallowed, then works after it', async () => {
    (window as unknown as { okDesktop?: unknown }).okDesktop = {};
    const bridge = createBridge();
    render(<ProjectSwitcher bridge={bridge as never} />);
    await openMenu();

    fireEvent.click(screen.getByTestId('project-switcher-recent-/projects/project-1'));
    expect(bridge.project.open).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 450));
    fireEvent.click(screen.getByTestId('project-switcher-recent-/projects/project-1'));
    await waitFor(() => expect(bridge.project.open).toHaveBeenCalledTimes(1));
  });

  test('does not flash "No recent projects." while the first listRecent is in flight, then resolves cleanly', async () => {
    let resolveList: (value: Array<{ name: string; path: string }>) => void = () => {};
    const pending = new Promise<Array<{ name: string; path: string }>>((resolve) => {
      resolveList = resolve;
    });
    const bridge = createBridge();
    bridge.project.listRecent = vi.fn(() => pending);
    render(<ProjectSwitcher bridge={bridge as never} />);

    fireEvent.click(screen.getByTestId('project-switcher-trigger'));
    act(() => {
      lastDropdownOpenChange?.(true);
    });

    expect(screen.queryByText('No recent projects.')).toBeNull();
    expect(screen.queryByTestId('project-switcher-search')).toBeNull();
    expect(screen.getByTestId('project-switcher-new-project')).not.toBeNull();

    await act(async () => {
      resolveList([recent('Current', '/projects/current'), recent('Project 1')]);
      await pending;
    });
    await waitFor(() => {
      expect(screen.getByTestId('project-switcher-search')).not.toBeNull();
    });
    expect(screen.queryByText('No recent projects.')).toBeNull();
  });

  test('shows "No recent projects." only once loaded AND genuinely empty', async () => {
    const bridge = createBridge();
    bridge.project.listRecent = vi.fn(() => Promise.resolve([]));
    render(<ProjectSwitcher bridge={bridge as never} />);

    fireEvent.click(screen.getByTestId('project-switcher-trigger'));
    act(() => {
      lastDropdownOpenChange?.(true);
    });

    await waitFor(() => {
      expect(screen.queryByText('No recent projects.')).not.toBeNull();
    });
    expect(screen.queryByTestId('project-switcher-search')).toBeNull();
  });
});
