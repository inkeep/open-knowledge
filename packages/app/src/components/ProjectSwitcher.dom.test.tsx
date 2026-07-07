import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ProjectSwitcher } from './ProjectSwitcher';

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

mock.module('@/components/ui/dropdown-menu', () => ({
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
}));

mock.module('@/components/ui/input-group', () => ({
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

mock.module('@/components/ui/sidebar', () => ({
  SidebarMenuButton: ({ children, ...props }: ItemProps) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

mock.module('./CreateProjectDialog', () => ({
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
mock.module('./NewWorktreeDialog', () => ({
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

// The current window's project is a git repo on `main` — drives the trigger's
// branch line and the gate on the top-level "New worktree…" item.
mock.module('@/hooks/use-current-branch', () => ({
  useCurrentBranch: () => 'main',
}));
// The switcher's cached worktree model feeds RecentProjectsMenu's grouped-view
// flyouts. A branch here ("omega-branch") would surface as a create-on-demand
// row in a projects-AND-worktrees search — the projects-only search must gate
// it out. Grouping/branch-search behavior is covered in
// RecentProjectsMenu.dom.test.tsx.
mock.module('@/hooks/use-worktrees', () => ({
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
        // Behind its origin/omega-branch upstream → feeds the dialog's
        // `behindByBranch` map for the N-behind hint.
        behind: 4,
      },
      // A branch that ALREADY has an open worktree — feeds the dialog's
      // `existingWorktreeBranches` set (non-null `worktreePath`).
      {
        branch: 'has-worktree',
        worktreePath: '/projects/current/.ok/worktrees/has-worktree',
        isCurrent: false,
        isMain: false,
        locked: false,
        // 0 behind → intentionally NOT threaded into behindByBranch (undefined ≠ 0
        // is the model's contract; here 0 is a real value that carries no nudge).
        behind: 0,
      },
    ],
    // Remote-tracking refs — feeds the dialog's remote-checkout mode + remote
    // base options. `origin/remote-only-x` has no local branch (remote-only).
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
      listRecent: mock(() =>
        Promise.resolve([
          recent('Current', '/projects/current'),
          ...Array.from({ length: 10 }, (_, index) => recent(`Project ${index + 1}`)),
          recent('Omega', '/archive/omega-project'),
          // A linked worktree whose branch matches "omega" — surfaces as a
          // worktree row in a projects-AND-worktrees search; the projects-only
          // search must filter it out.
          {
            name: 'omega-wt',
            path: '/archive/omega-wt',
            branch: 'omega-branch',
            isLinkedWorktree: true,
            mainRoot: '/archive/omega-project',
          },
        ]),
      ),
      open: mock(() => Promise.resolve()),
    },
    dialog: {
      openFolder: mock(() => Promise.resolve('/chosen/folder')),
    },
    navigator: {
      open: mock(() => Promise.resolve()),
    },
    worktree: {
      list: mock(() => Promise.resolve({ ok: false as const, reason: 'no-git' as const })),
      create: mock(() => Promise.resolve({ ok: false as const, reason: 'no-git' as const })),
    },
    onMenuAction: mock((cb: (action: string) => void) => {
      menuActionCb = cb;
      return () => {
        menuActionCb = null;
      };
    }),
  };
}

let menuActionCb: ((action: string) => void) | null = null;

async function openMenu() {
  fireEvent.click(screen.getByTestId('project-switcher-trigger'));
  act(() => {
    lastDropdownOpenChange?.(true);
  });
  await waitFor(() => {
    expect(screen.getByTestId('project-switcher-search')).not.toBeNull();
  });
}

describe('ProjectSwitcher dropdown behavior', () => {
  beforeEach(() => {
    cleanup();
    lastDropdownOpenChange = null;
    keydownBubbleCount = 0;
    createDialogProps = [];
    newWorktreeProps = [];
    menuActionCb = null;
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
    // "New worktree" moved to the BOTTOM of the menu (item 3): after Open folder.
    const newWorktreeIndex = menuText.indexOf('New worktree');
    expect(newProjectIndex).toBeGreaterThan(-1);
    expect(switchProjectIndex).toBeGreaterThan(newProjectIndex);
    expect(openFolderIndex).toBeGreaterThan(switchProjectIndex);
    expect(newWorktreeIndex).toBeGreaterThan(openFolderIndex);

    for (const testId of [
      'project-switcher-new-project',
      'project-switcher-switch-project',
      'project-switcher-open-folder',
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

    // Recents render through RecentProjectsMenu; a non-git recent opens with the
    // `recents` entry point.
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

  test('search matches projects only (not worktrees/branches), announces empty results, stops typeahead bubbling, and clears on close', async () => {
    const bridge = createBridge();
    render(<ProjectSwitcher bridge={bridge as never} />);

    await openMenu();

    const search = screen.getByTestId('project-switcher-search') as HTMLInputElement;
    // The search is projects-only now — per-project worktrees have their own
    // flyout + search. The placeholder + aria-label say so.
    expect(search.placeholder).toBe('Search projects...');
    expect(search.getAttribute('aria-label')).toBe('Search projects');

    fireEvent.keyDown(search, { key: 'O' });
    expect(keydownBubbleCount).toBe(0);

    fireEvent.change(search, { target: { value: 'omega' } });

    await waitFor(() => {
      expect(screen.getByTestId('project-switcher-recent-/archive/omega-project')).not.toBeNull();
    });
    expect(screen.queryByTestId('project-switcher-recent-/projects/project-1')).toBeNull();
    // "omega" also matches a linked worktree (branch "omega-branch") and a
    // create-on-demand branch from the worktree model — neither may appear in
    // the projects-only search. Only the project row above survives.
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
    // The standalone launcher resets the pre-fill so the dialog opens empty.
    expect(dialog.getAttribute('data-initial-name')).toBe('');
    expect(newWorktreeProps.at(-1)?.initialBranchName).toBe('');
  });

  test('the flyout "Create worktree …" action opens the dialog PRE-FILLED with the typed name', async () => {
    // A git-enriched current-project recent so RecentProjectsMenu renders the
    // grouped flyout for it (the create option only shows for the current
    // project). The cached model (mocked useWorktrees) has no branch matching
    // the query, so the flyout's no-match create option appears.
    const bridge = createBridge();
    bridge.project.listRecent = mock(() =>
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
        // A linked worktree so the group renders its expander (a group with zero
        // worktrees is a plain row with no flyout).
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

    // Open the current project's worktree flyout, type a non-matching name.
    fireEvent.click(screen.getByTestId('project-switcher-toggle-/projects/current'));
    const searchBox = (await screen.findByTestId(
      'project-switcher-flyout-search-/projects/current',
    )) as HTMLInputElement;
    fireEvent.change(searchBox, { target: { value: 'shiny-feature' } });

    const createOption = await screen.findByTestId('project-switcher-flyout-create');
    fireEvent.click(createOption);

    // The dialog opens pre-filled with the typed name.
    const dialog = await waitFor(() => {
      const el = screen.getByTestId('new-worktree-dialog');
      expect(el.getAttribute('data-open')).toBe('true');
      return el;
    });
    expect(dialog.getAttribute('data-initial-name')).toBe('shiny-feature');
    expect(newWorktreeProps.at(-1)?.initialBranchName).toBe('shiny-feature');
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
    // Both non-null-branch entries surface as selectable branches…
    expect(props?.branches).toContain('omega-branch');
    expect(props?.branches).toContain('has-worktree');
    // …but only the one with a non-null `worktreePath` is in the
    // already-has-a-worktree set.
    expect(props?.existingWorktreeBranches?.has('has-worktree')).toBe(true);
    expect(props?.existingWorktreeBranches?.has('omega-branch')).toBe(false);
    // Remote-tracking refs thread through verbatim for the remote-checkout mode
    // + remote base options.
    expect(props?.remoteBranches).toEqual([
      'origin/main',
      'origin/omega-branch',
      'origin/remote-only-x',
    ]);
    // Behind counts thread from entries → map for every entry with a DEFINED
    // count (including a real 0). The dialog decides whether to render a nudge
    // (only for >0); the wiring just carries the data faithfully.
    expect(props?.behindByBranch?.get('omega-branch')).toBe(4);
    expect(props?.behindByBranch?.get('has-worktree')).toBe(0);
  });

  test('File menu "new-worktree" action opens the New Worktree dialog; "switch-worktree" opens the dropdown', async () => {
    const bridge = createBridge();
    render(<ProjectSwitcher bridge={bridge as never} />);
    expect(menuActionCb).not.toBeNull();

    act(() => menuActionCb?.('new-worktree'));
    await waitFor(() =>
      expect(screen.getByTestId('new-worktree-dialog').getAttribute('data-open')).toBe('true'),
    );

    act(() => menuActionCb?.('switch-worktree'));
    await waitFor(() => {
      expect(screen.getByTestId('project-switcher-search')).not.toBeNull();
    });
  });

  test('on the Electron host, a row selection within the open-click guard window is swallowed, then works after it', async () => {
    (window as unknown as { okDesktop?: unknown }).okDesktop = {};
    const bridge = createBridge();
    render(<ProjectSwitcher bridge={bridge as never} />);
    await openMenu();

    // Immediately after open → the Electron open-click fall-through. Swallowed.
    fireEvent.click(screen.getByTestId('project-switcher-recent-/projects/project-1'));
    expect(bridge.project.open).not.toHaveBeenCalled();

    // After the guard timer elapses → a deliberate click opens the project.
    await new Promise((resolve) => setTimeout(resolve, 450));
    fireEvent.click(screen.getByTestId('project-switcher-recent-/projects/project-1'));
    await waitFor(() => expect(bridge.project.open).toHaveBeenCalledTimes(1));
  });

  test('does not flash "No recent projects." while the first listRecent is in flight, then resolves cleanly', async () => {
    // A listRecent that stays pending lets us observe the not-yet-loaded state:
    // the menu is open but the fetch hasn't resolved. The empty label must NOT
    // render here — that's the first-open flicker the loading sentinel removes.
    let resolveList: (value: Array<{ name: string; path: string }>) => void = () => {};
    const pending = new Promise<Array<{ name: string; path: string }>>((resolve) => {
      resolveList = resolve;
    });
    const bridge = createBridge();
    bridge.project.listRecent = mock(() => pending);
    render(<ProjectSwitcher bridge={bridge as never} />);

    // Open the menu but do NOT wait for the search box (it can't appear until
    // the fetch resolves) — the fetch is still pending at this point.
    fireEvent.click(screen.getByTestId('project-switcher-trigger'));
    act(() => {
      lastDropdownOpenChange?.(true);
    });

    // Not-yet-loaded: neither the empty label nor the search box is shown, but
    // the pinned footer actions still render.
    expect(screen.queryByText('No recent projects.')).toBeNull();
    expect(screen.queryByTestId('project-switcher-search')).toBeNull();
    expect(screen.getByTestId('project-switcher-new-project')).not.toBeNull();

    // Resolve with a non-empty list → the search box + recents render, still no
    // empty label.
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
    bridge.project.listRecent = mock(() => Promise.resolve([]));
    render(<ProjectSwitcher bridge={bridge as never} />);

    fireEvent.click(screen.getByTestId('project-switcher-trigger'));
    act(() => {
      lastDropdownOpenChange?.(true);
    });

    // Once the (empty) fetch resolves, the label is correct — the list really
    // is empty, and there are no recents to search.
    await waitFor(() => {
      expect(screen.queryByText('No recent projects.')).not.toBeNull();
    });
    expect(screen.queryByTestId('project-switcher-search')).toBeNull();
  });
});
