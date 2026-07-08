import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { WorktreeSelectorModel } from '@inkeep/open-knowledge-core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createContext, type ReactNode, use, useState } from 'react';
import type { RecentProjectEntry } from '@/lib/desktop-bridge-types';
import { RecentProjectsMenu } from './RecentProjectsMenu';

type ItemProps = {
  children?: ReactNode;
  disabled?: boolean;
  onSelect?: (e?: unknown) => void;
  [key: string]: unknown;
};

// DropdownMenuItem is a div (role=menuitem), matching reality — the real one is
// not a <button>. onSelect fires on click; onKeyDown (from props) drives the
// flyout list's manual roving focus.
//
// The worktree flyout is a real DropdownMenuSub, modeled here through a shared
// { open, onOpenChange } context: SubTrigger opens on click / mouseenter /
// ArrowRight and closes on ArrowLeft / Escape / mouseleave; SubContent renders
// only while open and closes on mouseleave. Radix's safe-triangle + close-on-
// leave-both geometry can't run in jsdom, so the mock models the onOpenChange
// contract the component wires to (asserting the flyout closes when Radix
// reports hover-out). Focus-into-search on open is the component's own effect,
// not simulated here.
const SubStateContext = createContext<{ open: boolean; onOpenChange: (o: boolean) => void }>({
  open: false,
  onOpenChange: () => {},
});
mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({ children, onSelect, ...props }: ItemProps) => (
    <div
      role="menuitem"
      tabIndex={-1}
      onClick={(e) => onSelect?.(e as unknown as Event)}
      onKeyDown={() => {}}
      {...props}
    >
      {children}
    </div>
  ),
  DropdownMenuLabel: ({ children, ...props }: ItemProps) => <div {...props}>{children}</div>,
  DropdownMenuSub: ({
    children,
    open,
    onOpenChange,
  }: {
    children?: ReactNode;
    open?: boolean;
    onOpenChange?: (o: boolean) => void;
  }) => (
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
    // Model Radix's SubTrigger composition: our handler runs first, and Radix
    // opens the sub only if we did NOT preventDefault. The component preventDefaults
    // a click on the project-name target (data-project-open) and Enter / Space, to
    // open the project instead — so those do NOT open the flyout; a click elsewhere
    // on the row, hover, and ArrowRight open the flyout; ArrowLeft / Escape close it.
    return (
      <div
        role="menuitem"
        tabIndex={-1}
        onMouseEnter={() => onOpenChange(true)}
        onMouseLeave={() => onOpenChange(false)}
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
    ...props
  }: ItemProps & { sideOffset?: number }) => {
    const { open, onOpenChange } = use(SubStateContext);
    if (!open) return null;
    // role="menu" mirrors the real DropdownMenuSubContent and satisfies the
    // static-interactive-element lint on the hover-out handler.
    return (
      <div role="menu" onMouseLeave={() => onOpenChange(false)} {...props}>
        {children}
      </div>
    );
  },
}));

mock.module('@/components/ui/input-group', () => ({
  InputGroup: ({ children, ...props }: ItemProps) => <div {...props}>{children}</div>,
  InputGroupAddon: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  InputGroupInput: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

const refreshWorktrees = mock(() => {});
mock.module('@/lib/worktree-store', () => ({ refreshWorktrees }));
const toastError = mock((_msg: string) => {});
mock.module('sonner', () => ({ toast: { error: toastError, success: mock(() => {}) } }));

function main(path: string, commonDir: string): RecentProjectEntry {
  return {
    path,
    name: path.split('/').pop() ?? path,
    lastOpenedAt: '2026-07-01',
    gitCommonDir: commonDir,
    mainRoot: path,
    isLinkedWorktree: false,
    branch: 'main',
  };
}
function worktree(
  path: string,
  commonDir: string,
  mainRoot: string,
  branch: string,
  lastOpenedAt = '2026-07-01',
): RecentProjectEntry {
  return {
    path,
    name: path.split('/').pop() ?? path,
    lastOpenedAt,
    gitCommonDir: commonDir,
    mainRoot,
    isLinkedWorktree: true,
    branch,
  };
}
function nonGit(path: string): RecentProjectEntry {
  return { path, name: path.split('/').pop() ?? path, lastOpenedAt: '2026-07-01' };
}

function model(
  entries: WorktreeSelectorModel['entries'],
  mainRoot = '/repo',
): WorktreeSelectorModel {
  return { mainRoot, currentBranch: 'main', entries, remoteBranches: [] };
}

function createBridge() {
  return {
    project: { open: mock(() => Promise.resolve()) },
    worktree: {
      create: mock(() =>
        Promise.resolve({
          ok: true as const,
          path: '/repo/.ok/worktrees/feature-x',
          created: true,
        }),
      ),
    },
  };
}

const noGuard = () => false;

// A stateful host for RecentProjectsMenu so the hoisted flyoutPath (owned by
// ProjectSwitcher in production) is toggled the same way here — clicking a
// group's expander flips flyoutPath, which renders that group's flyout.
function Host({
  bridge,
  recents,
  currentPath,
  query,
  worktreeModel,
  closeMenu,
  openNewWorktreeWith,
}: {
  bridge: ReturnType<typeof createBridge>;
  recents: RecentProjectEntry[];
  currentPath: string;
  query: string;
  worktreeModel: WorktreeSelectorModel | null;
  closeMenu: () => void;
  openNewWorktreeWith: (name: string) => void;
}) {
  const [flyoutPath, setFlyoutPath] = useState<string | null>(null);
  return (
    <RecentProjectsMenu
      bridge={bridge as never}
      recents={recents}
      currentPath={currentPath}
      query={query}
      worktreeModel={worktreeModel}
      closeMenu={closeMenu}
      guardStaleSelect={noGuard}
      flyoutPath={flyoutPath}
      setFlyoutPath={setFlyoutPath}
      openNewWorktreeWith={openNewWorktreeWith}
    />
  );
}

function renderMenu(
  overrides: Partial<{
    bridge: ReturnType<typeof createBridge>;
    recents: RecentProjectEntry[];
    currentPath: string;
    query: string;
    worktreeModel: WorktreeSelectorModel | null;
    closeMenu: () => void;
    openNewWorktreeWith: (name: string) => void;
  }> = {},
) {
  const bridge = overrides.bridge ?? createBridge();
  const closeMenu = overrides.closeMenu ?? mock(() => {});
  const openNewWorktreeWith = overrides.openNewWorktreeWith ?? mock((_name: string) => {});
  render(
    <Host
      bridge={bridge}
      recents={overrides.recents ?? []}
      currentPath={overrides.currentPath ?? '/other'}
      query={overrides.query ?? ''}
      worktreeModel={overrides.worktreeModel ?? null}
      closeMenu={closeMenu}
      openNewWorktreeWith={openNewWorktreeWith}
    />,
  );
  return { bridge, closeMenu, openNewWorktreeWith };
}

describe('RecentProjectsMenu — grouped browse (no query)', () => {
  beforeEach(cleanup);

  test('project rows carry NO folder icon (switcher stays focused on names)', () => {
    renderMenu({ recents: [nonGit('/notes')] });
    const row = screen.getByTestId('project-switcher-recent-/notes');
    // Folder icon removed. A non-git row renders no icon at all.
    expect(row.querySelector('svg')).toBeNull();
  });

  test('clicking the row body (not the name) opens the worktree flyout, not the project', async () => {
    const { bridge } = renderMenu({
      recents: [
        main('/repo', '/repo/.git'),
        worktree('/repo/.ok/worktrees/dev', '/repo/.git', '/repo', 'dev'),
      ],
    });

    // Flyout is closed by default — its content is not rendered.
    const groupRow = screen.getByTestId('project-switcher-group-/repo');
    expect(groupRow.textContent).toContain('/repo');
    expect(screen.queryByTestId('project-switcher-flyout-/repo')).toBeNull();

    // The count chip carries the pluralized worktree count ("1 worktree" at one;
    // "N worktrees" otherwise) with no icon of its own — the disclosure chevron
    // is the DropdownMenuSubTrigger's built-in (not rendered by the mock).
    const toggle = screen.getByTestId('project-switcher-toggle-/repo');
    expect(toggle.querySelectorAll('svg').length).toBe(0);
    expect(toggle.textContent).toContain('1 worktree');
    expect(toggle.textContent).not.toContain('1 worktrees');

    // Two-target row: clicking a NON-name part of the row (here the count chip)
    // opens the submenu (flyout) — the big, easy target — and does NOT open the
    // project. Radix's SubTrigger opens the sub on click because the handler only
    // preventDefaults for the name target (see the next test).
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(screen.getByTestId('project-switcher-flyout-/repo')).not.toBeNull();
    });
    expect(bridge.project.open).not.toHaveBeenCalled();
  });

  test('clicking the project name opens the project (root) directly, not the flyout', async () => {
    const { bridge } = renderMenu({
      recents: [
        main('/repo', '/repo/.git'),
        worktree('/repo/.ok/worktrees/dev', '/repo/.git', '/repo', 'dev'),
      ],
    });
    const groupRow = screen.getByTestId('project-switcher-group-/repo');
    expect(screen.queryByTestId('project-switcher-flyout-/repo')).toBeNull();

    // The project name is the direct open-project target (tagged
    // data-project-open); the row's onClick routes name-clicks to the project.
    const nameTarget = groupRow.querySelector('[data-project-open]');
    expect(nameTarget?.textContent).toBe('repo');

    // Name-click opens the bare project (root) in one click, and does NOT also
    // open the flyout — the click preventDefaults Radix's open (no double-fire).
    fireEvent.click(nameTarget as Element);
    await waitFor(() => {
      expect(bridge.project.open).toHaveBeenCalledWith({
        path: '/repo',
        target: 'new-window',
        entryPoint: 'recents',
      });
    });
    expect(screen.queryByTestId('project-switcher-flyout-/repo')).toBeNull();
  });

  test('hovering the submenu row opens the flyout (hover-open, not click-only) without opening the project', async () => {
    const { bridge } = renderMenu({
      recents: [
        main('/repo', '/repo/.git'),
        worktree('/repo/.ok/worktrees/dev', '/repo/.git', '/repo', 'dev'),
      ],
    });
    expect(screen.queryByTestId('project-switcher-flyout-/repo')).toBeNull();
    // DropdownMenuSub opens the submenu on hover of its trigger row (Radix
    // safe-triangle hover); the mock models that onOpenChange(true) wiring.
    fireEvent.mouseEnter(screen.getByTestId('project-switcher-group-/repo'));
    await waitFor(() => {
      expect(screen.getByTestId('project-switcher-flyout-/repo')).not.toBeNull();
    });
    expect(bridge.project.open).not.toHaveBeenCalled();
  });

  test('the flyout closes when the pointer leaves both the row and the flyout (close-on-hover-out)', async () => {
    renderMenu({
      recents: [
        main('/repo', '/repo/.git'),
        worktree('/repo/.ok/worktrees/dev', '/repo/.git', '/repo', 'dev'),
      ],
    });
    // Hover the row → flyout opens.
    fireEvent.mouseEnter(screen.getByTestId('project-switcher-group-/repo'));
    const flyout = await screen.findByTestId('project-switcher-flyout-/repo');
    // Leaving the flyout content (the pointer is now inside neither the trigger
    // nor the content) → Radix reports onOpenChange(false) and the flyout closes.
    // The safe-triangle / leave-BOTH geometry is Radix-native (verified live on
    // the Electron POC); the mock exercises the onOpenChange(false) wiring that
    // RecentProjectsMenu hooks up via the hoisted flyout state.
    fireEvent.mouseLeave(flyout);
    await waitFor(() => {
      expect(screen.queryByTestId('project-switcher-flyout-/repo')).toBeNull();
    });
  });

  test('keyboard: ArrowRight on the group row opens its flyout; ArrowLeft and Escape close it (a11y C7)', async () => {
    const { bridge } = renderMenu({
      recents: [
        main('/repo', '/repo/.git'),
        worktree('/repo/.ok/worktrees/dev', '/repo/.git', '/repo', 'dev'),
      ],
    });
    const row = screen.getByTestId('project-switcher-group-/repo');
    expect(screen.queryByTestId('project-switcher-flyout-/repo')).toBeNull();

    // ArrowRight is the standard submenu key and is not intercepted, so it opens
    // the flyout from the focused row — without opening the project (Enter/Space
    // open the project instead; see the two-target test above).
    fireEvent.keyDown(row, { key: 'ArrowRight' });
    await waitFor(() => {
      expect(screen.getByTestId('project-switcher-flyout-/repo')).not.toBeNull();
    });
    expect(bridge.project.open).not.toHaveBeenCalled();

    // Focus moves INTO the flyout (onto its search input) so the list + create
    // option are keyboard-reachable.
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByTestId('project-switcher-flyout-search-/repo'),
      );
    });

    // ArrowLeft closes it again.
    fireEvent.keyDown(row, { key: 'ArrowLeft' });
    await waitFor(() => {
      expect(screen.queryByTestId('project-switcher-flyout-/repo')).toBeNull();
    });

    // Re-open, then Escape closes it too.
    fireEvent.keyDown(row, { key: 'ArrowRight' });
    await waitFor(() => {
      expect(screen.getByTestId('project-switcher-flyout-/repo')).not.toBeNull();
    });
    fireEvent.keyDown(row, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('project-switcher-flyout-/repo')).toBeNull();
    });
  });

  test('keyboard: Enter (and Space) on the group row opens the PROJECT, not the flyout (two-target)', async () => {
    const { bridge } = renderMenu({
      recents: [
        main('/repo', '/repo/.git'),
        worktree('/repo/.ok/worktrees/dev', '/repo/.git', '/repo', 'dev'),
      ],
    });
    const row = screen.getByTestId('project-switcher-group-/repo');

    // Enter opens the bare project (the SUB_OPEN key is preventDefaulted so Radix
    // does not open the submenu instead) and leaves the flyout closed — matching
    // the name being the primary target. ArrowRight (below) opens the submenu.
    fireEvent.keyDown(row, { key: 'Enter' });
    await waitFor(() => {
      expect(bridge.project.open).toHaveBeenCalledWith({
        path: '/repo',
        target: 'new-window',
        entryPoint: 'recents',
      });
    });
    expect(screen.queryByTestId('project-switcher-flyout-/repo')).toBeNull();

    // Space behaves identically.
    fireEvent.keyDown(row, { key: ' ' });
    await waitFor(() => expect(bridge.project.open).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('project-switcher-flyout-/repo')).toBeNull();
  });

  test('the flyout lists the default (main) first, then the opened worktree; opening one opens its window', async () => {
    const { bridge } = renderMenu({
      recents: [
        main('/repo', '/repo/.git'),
        worktree('/repo/.ok/worktrees/dev', '/repo/.git', '/repo', 'dev'),
      ],
    });
    fireEvent.mouseEnter(screen.getByTestId('project-switcher-group-/repo'));

    // main (default, pinned) is entry /repo; the dev worktree follows.
    const mainEntry = await screen.findByTestId('project-switcher-flyout-entry-/repo');
    expect(mainEntry.textContent).toContain('main');
    expect(mainEntry.textContent).toContain('default');
    const devEntry = screen.getByTestId('project-switcher-flyout-entry-/repo/.ok/worktrees/dev');
    expect(devEntry.textContent).toContain('dev');

    // No per-row GitBranch icon — the "default" chip above (and "create
    // worktree" on un-opened branches, covered elsewhere) carries the
    // distinction instead. The flyout's icons live on the search input, not on
    // every row.
    expect(mainEntry.querySelector('svg')).toBeNull();
    expect(devEntry.querySelector('svg')).toBeNull();
    const flyoutSearch = screen.getByTestId('project-switcher-flyout-search-/repo');
    // Search magnifier (leading) is the only icon on the field — the trailing
    // branch icon was removed as unnecessary.
    expect(flyoutSearch.parentElement?.querySelectorAll('svg').length).toBe(1);

    fireEvent.click(devEntry);
    await waitFor(() => {
      expect(bridge.project.open).toHaveBeenCalledWith({
        path: '/repo/.ok/worktrees/dev',
        target: 'new-window',
        entryPoint: 'worktree',
      });
    });
  });

  test('opened worktrees sort by recency (most-recently-opened first)', async () => {
    renderMenu({
      recents: [
        main('/repo', '/repo/.git'),
        worktree('/repo/.ok/worktrees/older', '/repo/.git', '/repo', 'older', '2026-06-01'),
        worktree('/repo/.ok/worktrees/newer', '/repo/.git', '/repo', 'newer', '2026-06-30'),
      ],
    });
    // Two worktrees → the count control reads the plural form.
    expect(screen.getByTestId('project-switcher-toggle-/repo').textContent).toContain(
      '2 worktrees',
    );
    fireEvent.mouseEnter(screen.getByTestId('project-switcher-group-/repo'));

    const flyout = await screen.findByTestId('project-switcher-flyout-/repo');
    const ids = [...flyout.querySelectorAll('[data-testid^="project-switcher-flyout-entry-"]')].map(
      (el) => el.getAttribute('data-testid'),
    );
    // main pinned first; then newer before older by lastOpenedAt.
    expect(ids).toEqual([
      'project-switcher-flyout-entry-/repo',
      'project-switcher-flyout-entry-/repo/.ok/worktrees/newer',
      'project-switcher-flyout-entry-/repo/.ok/worktrees/older',
    ]);
  });

  test('count chip + flyout affordance single-source from the builder: a model-known opened worktree not in Recents still counts', async () => {
    // The current project's git model knows an opened worktree ("ghost") that
    // Recents never listed. The count chip and the flyout gate both derive from
    // buildWorktreeFlyoutEntries (which merges the model for the current
    // project), so this worktree surfaces the submenu affordance and is counted
    // — where the old Recents-only count would have shown a plain row with none.
    renderMenu({
      recents: [main('/repo', '/repo/.git')],
      currentPath: '/repo',
      worktreeModel: model([
        { branch: 'main', worktreePath: '/repo', isCurrent: true, isMain: true, locked: false },
        {
          branch: 'ghost',
          worktreePath: '/repo/.ok/worktrees/ghost',
          isCurrent: false,
          isMain: false,
          locked: false,
        },
      ]),
    });
    // Submenu row (not a plain row), and the chip counts the one opened, non-main
    // worktree — the pinned "default" (main) is not itself counted.
    expect(screen.getByTestId('project-switcher-group-/repo')).not.toBeNull();
    expect(screen.getByTestId('project-switcher-toggle-/repo').textContent).toContain('1 worktree');

    fireEvent.mouseEnter(screen.getByTestId('project-switcher-group-/repo'));
    await screen.findByTestId('project-switcher-flyout-/repo');
    // The list shows the same worktree the count implies.
    expect(
      screen.getByTestId('project-switcher-flyout-entry-/repo/.ok/worktrees/ghost'),
    ).not.toBeNull();
  });

  test('the flyout search filters that project’s worktrees + branches; a create-on-demand branch creates its worktree', async () => {
    const { bridge } = renderMenu({
      recents: [
        main('/repo', '/repo/.git'),
        worktree('/repo/.ok/worktrees/dev', '/repo/.git', '/repo', 'dev'),
      ],
      currentPath: '/repo',
      worktreeModel: model([
        { branch: 'main', worktreePath: '/repo', isCurrent: true, isMain: true, locked: false },
        {
          branch: 'dev',
          worktreePath: '/repo/.ok/worktrees/dev',
          isCurrent: false,
          isMain: false,
          locked: false,
        },
        { branch: 'feature-x', worktreePath: null, isCurrent: false, isMain: false, locked: false },
      ]),
    });
    fireEvent.mouseEnter(screen.getByTestId('project-switcher-group-/repo'));
    await screen.findByTestId('project-switcher-flyout-/repo');

    // The un-opened branch is present (create-on-demand) and flagged "create".
    const createRow = screen.getByTestId('project-switcher-flyout-entry-branch:feature-x');
    expect(createRow.textContent).toContain('feature-x');
    expect(createRow.textContent).toContain('create worktree');

    // Filter to just the create-on-demand branch.
    const searchBox = screen.getByTestId(
      'project-switcher-flyout-search-/repo',
    ) as HTMLInputElement;
    // The search input's placeholder must be extractable/localized (regression
    // guard: prop-drilling `t` left every string in these sub-components blank).
    expect(searchBox.placeholder).toBe('Search worktrees');
    fireEvent.change(searchBox, { target: { value: 'feature' } });
    await waitFor(() => {
      expect(
        screen.queryByTestId('project-switcher-flyout-entry-/repo/.ok/worktrees/dev'),
      ).toBeNull();
    });
    expect(screen.getByTestId('project-switcher-flyout-entry-branch:feature-x')).not.toBeNull();

    // Selecting it creates the worktree then opens the window.
    fireEvent.click(screen.getByTestId('project-switcher-flyout-entry-branch:feature-x'));
    await waitFor(() => {
      expect(bridge.worktree.create).toHaveBeenCalledWith({
        branch: 'feature-x',
        createBranch: false,
      });
    });
    await waitFor(() => {
      expect(bridge.project.open).toHaveBeenCalledWith({
        path: '/repo/.ok/worktrees/feature-x',
        target: 'new-window',
        entryPoint: 'worktree',
      });
    });
    expect(refreshWorktrees).toHaveBeenCalled();
  });

  test('the current project flyout offers "Create worktree <query>" when nothing matches; clicking it opens the pre-filled dialog', async () => {
    const openNewWorktreeWith = mock((_name: string) => {});
    renderMenu({
      recents: [
        main('/repo', '/repo/.git'),
        worktree('/repo/.ok/worktrees/dev', '/repo/.git', '/repo', 'dev'),
      ],
      currentPath: '/repo',
      worktreeModel: model([
        { branch: 'main', worktreePath: '/repo', isCurrent: true, isMain: true, locked: false },
        {
          branch: 'dev',
          worktreePath: '/repo/.ok/worktrees/dev',
          isCurrent: false,
          isMain: false,
          locked: false,
        },
      ]),
      openNewWorktreeWith,
    });
    fireEvent.mouseEnter(screen.getByTestId('project-switcher-group-/repo'));
    await screen.findByTestId('project-switcher-flyout-/repo');

    // A query matching no worktree/branch. The empty label stays, AND a clickable
    // create option carrying the typed name appears.
    const searchBox = screen.getByTestId(
      'project-switcher-flyout-search-/repo',
    ) as HTMLInputElement;
    fireEvent.change(searchBox, { target: { value: '  new-thing  ' } });
    await waitFor(() => {
      expect(screen.getByText('No matching worktrees or branches.')).not.toBeNull();
    });
    const createOption = screen.getByTestId('project-switcher-flyout-create');
    // The trimmed query is what's shown (and what gets pre-filled).
    expect(createOption.textContent).toContain('Create worktree');
    expect(createOption.textContent).toContain('new-thing');

    fireEvent.click(createOption);
    expect(openNewWorktreeWith).toHaveBeenCalledWith('new-thing');
  });

  test('the create option is absent when the query is only whitespace (nothing to name)', async () => {
    renderMenu({
      recents: [
        main('/repo', '/repo/.git'),
        worktree('/repo/.ok/worktrees/dev', '/repo/.git', '/repo', 'dev'),
      ],
      currentPath: '/repo',
      worktreeModel: model([
        { branch: 'main', worktreePath: '/repo', isCurrent: true, isMain: true, locked: false },
        {
          branch: 'dev',
          worktreePath: '/repo/.ok/worktrees/dev',
          isCurrent: false,
          isMain: false,
          locked: false,
        },
      ]),
    });
    fireEvent.mouseEnter(screen.getByTestId('project-switcher-group-/repo'));
    await screen.findByTestId('project-switcher-flyout-/repo');
    const searchBox = screen.getByTestId(
      'project-switcher-flyout-search-/repo',
    ) as HTMLInputElement;
    // Whitespace-only trims to empty: entries still match (nothing filtered out),
    // so the empty-state branch never renders and there's no name to create with.
    fireEvent.change(searchBox, { target: { value: '   ' } });
    expect(screen.queryByTestId('project-switcher-flyout-create')).toBeNull();
  });

  test('a NON-current project flyout does NOT offer the create option (creation anchors to the current project)', async () => {
    // The switcher's cached model belongs to a DIFFERENT project than this
    // group, so create-on-demand isn't meaningful here — the option is hidden.
    renderMenu({
      recents: [
        main('/repo', '/repo/.git'),
        worktree('/repo/.ok/worktrees/dev', '/repo/.git', '/repo', 'dev'),
      ],
      currentPath: '/elsewhere',
      worktreeModel: model(
        [
          {
            branch: 'other-branch',
            worktreePath: null,
            isCurrent: false,
            isMain: false,
            locked: false,
          },
        ],
        '/elsewhere',
      ),
    });
    fireEvent.mouseEnter(screen.getByTestId('project-switcher-group-/repo'));
    await screen.findByTestId('project-switcher-flyout-/repo');
    const searchBox = screen.getByTestId(
      'project-switcher-flyout-search-/repo',
    ) as HTMLInputElement;
    fireEvent.change(searchBox, { target: { value: 'zzz-no-match' } });
    await waitFor(() => {
      expect(screen.getByText('No matching worktrees or branches.')).not.toBeNull();
    });
    // No create option in a non-current project's flyout.
    expect(screen.queryByTestId('project-switcher-flyout-create')).toBeNull();
  });

  test('a non-current project flyout shows only its opened worktrees (no branch model)', async () => {
    // worktreeModel belongs to a DIFFERENT project, so it must not leak in.
    renderMenu({
      recents: [
        main('/repo', '/repo/.git'),
        worktree('/repo/.ok/worktrees/dev', '/repo/.git', '/repo', 'dev'),
      ],
      currentPath: '/elsewhere',
      worktreeModel: model(
        [
          {
            branch: 'other-branch',
            worktreePath: null,
            isCurrent: false,
            isMain: false,
            locked: false,
          },
        ],
        '/elsewhere',
      ),
    });
    fireEvent.mouseEnter(screen.getByTestId('project-switcher-group-/repo'));
    const flyout = await screen.findByTestId('project-switcher-flyout-/repo');
    // main + dev only; the other project's branch does not appear.
    expect(flyout.textContent).not.toContain('other-branch');
    expect(screen.getByTestId('project-switcher-flyout-entry-/repo')).not.toBeNull();
    expect(
      screen.getByTestId('project-switcher-flyout-entry-/repo/.ok/worktrees/dev'),
    ).not.toBeNull();
  });

  test('the flyout’s pinned "default" entry also opens the project root (secondary path to the same action)', async () => {
    // Clicking the project name is the primary one-click open (covered above);
    // the repo's default/main checkout is also the pinned first flyout entry,
    // opening the same bare root with the `recents` entry point.
    const { bridge } = renderMenu({
      recents: [
        main('/repo', '/repo/.git'),
        worktree('/repo/.ok/worktrees/dev', '/repo/.git', '/repo', 'dev'),
      ],
    });
    fireEvent.mouseEnter(screen.getByTestId('project-switcher-group-/repo'));
    // Hover opened the flyout — it did NOT open the project directly.
    const mainEntry = await screen.findByTestId('project-switcher-flyout-entry-/repo');
    expect(bridge.project.open).not.toHaveBeenCalled();

    fireEvent.click(mainEntry);
    await waitFor(() => {
      expect(bridge.project.open).toHaveBeenCalledWith({
        path: '/repo',
        target: 'new-window',
        entryPoint: 'recents',
      });
    });
  });

  test('a non-git recent is a flat row that opens with the recents entry point', async () => {
    const { bridge } = renderMenu({ recents: [nonGit('/notes')] });
    expect(screen.queryByTestId('project-switcher-group-/notes')).toBeNull();
    fireEvent.click(screen.getByTestId('project-switcher-recent-/notes'));
    await waitFor(() => {
      expect(bridge.project.open).toHaveBeenCalledWith({
        path: '/notes',
        target: 'new-window',
        entryPoint: 'recents',
      });
    });
  });

  test('the current project row no-ops on select and just closes the menu', async () => {
    const { bridge, closeMenu } = renderMenu({
      recents: [nonGit('/notes')],
      currentPath: '/notes',
    });
    fireEvent.click(screen.getByTestId('project-switcher-recent-/notes'));
    expect(bridge.project.open).not.toHaveBeenCalled();
    expect(closeMenu).toHaveBeenCalled();
  });

  test('a repo present only via a worktree synthesizes the project row', async () => {
    renderMenu({
      recents: [worktree('/repo/.ok/worktrees/dev', '/repo/.git', '/repo', 'dev')],
    });
    // Group exists (synthesized from mainRoot) with its path; the expander reveals
    // the worktree flyout.
    const groupRow = screen.getByTestId('project-switcher-group-/repo');
    expect(groupRow.textContent).toContain('/repo');
    fireEvent.mouseEnter(screen.getByTestId('project-switcher-group-/repo'));
    // Synthesized project has no pinned main entry (never opened); the dev
    // worktree is present.
    await screen.findByTestId('project-switcher-flyout-/repo');
    expect(
      screen.getByTestId('project-switcher-flyout-entry-/repo/.ok/worktrees/dev'),
    ).not.toBeNull();
    expect(screen.queryByTestId('project-switcher-flyout-entry-/repo')).toBeNull();
  });
});

describe('RecentProjectsMenu — flyout keyboard navigation (item 29)', () => {
  beforeEach(cleanup);

  // main (pinned) + two opened worktrees → three list rows to rove through:
  //   [0] /repo (main, "default")   [1] newer   [2] older
  function openThreeRowFlyout() {
    const utils = renderMenu({
      recents: [
        main('/repo', '/repo/.git'),
        worktree('/repo/.ok/worktrees/older', '/repo/.git', '/repo', 'older', '2026-06-01'),
        worktree('/repo/.ok/worktrees/newer', '/repo/.git', '/repo', 'newer', '2026-06-30'),
      ],
    });
    // Open via ArrowRight on the group row so focus lands in the search input,
    // exactly as it does for a keyboard user.
    fireEvent.keyDown(screen.getByTestId('project-switcher-group-/repo'), { key: 'ArrowRight' });
    return utils;
  }

  const row = (key: string) => screen.getByTestId(`project-switcher-flyout-entry-${key}`);

  test('ArrowDown from the search input moves focus to the first entry row', async () => {
    openThreeRowFlyout();
    const search = await screen.findByTestId('project-switcher-flyout-search-/repo');
    await waitFor(() => expect(document.activeElement).toBe(search));

    fireEvent.keyDown(search, { key: 'ArrowDown' });
    // First row is the pinned main worktree (/repo).
    expect(document.activeElement).toBe(row('/repo'));
  });

  test('ArrowDown / ArrowUp rove through the entry rows and clamp at the ends', async () => {
    openThreeRowFlyout();
    const search = await screen.findByTestId('project-switcher-flyout-search-/repo');
    await waitFor(() => expect(document.activeElement).toBe(search));

    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row('/repo'));

    // Down through newer, then older (recency order matches the render order).
    fireEvent.keyDown(row('/repo'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row('/repo/.ok/worktrees/newer'));
    fireEvent.keyDown(row('/repo/.ok/worktrees/newer'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row('/repo/.ok/worktrees/older'));

    // ArrowDown on the last row clamps (stays on the last row).
    fireEvent.keyDown(row('/repo/.ok/worktrees/older'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row('/repo/.ok/worktrees/older'));

    // Back up to the first row.
    fireEvent.keyDown(row('/repo/.ok/worktrees/older'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(row('/repo/.ok/worktrees/newer'));
    fireEvent.keyDown(row('/repo/.ok/worktrees/newer'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(row('/repo'));
  });

  test('ArrowUp from the first entry row returns focus to the search input', async () => {
    openThreeRowFlyout();
    const search = await screen.findByTestId('project-switcher-flyout-search-/repo');
    await waitFor(() => expect(document.activeElement).toBe(search));

    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row('/repo'));

    fireEvent.keyDown(row('/repo'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(search);
  });

  test('Enter on a focused entry row opens that worktree (same action as a click)', async () => {
    const { bridge } = openThreeRowFlyout();
    const search = await screen.findByTestId('project-switcher-flyout-search-/repo');
    await waitFor(() => expect(document.activeElement).toBe(search));

    // Arrow to the "newer" worktree, then Enter to open it.
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(row('/repo'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row('/repo/.ok/worktrees/newer'));

    fireEvent.keyDown(row('/repo/.ok/worktrees/newer'), { key: 'Enter' });
    await waitFor(() => {
      expect(bridge.project.open).toHaveBeenCalledWith({
        path: '/repo/.ok/worktrees/newer',
        target: 'new-window',
        entryPoint: 'worktree',
      });
    });
  });

  test('typing in the search still filters the list, and ArrowDown enters the filtered rows', async () => {
    openThreeRowFlyout();
    const search = (await screen.findByTestId(
      'project-switcher-flyout-search-/repo',
    )) as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(search));

    // Filter to just "newer".
    fireEvent.change(search, { target: { value: 'newer' } });
    await waitFor(() => {
      expect(
        screen.queryByTestId('project-switcher-flyout-entry-/repo/.ok/worktrees/older'),
      ).toBeNull();
    });
    // ArrowDown lands on the single remaining (filtered) row, not a stale one.
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row('/repo/.ok/worktrees/newer'));
  });
});

describe('RecentProjectsMenu — search (cross-project)', () => {
  beforeEach(cleanup);

  test('project search rows carry NO folder icon', () => {
    renderMenu({ recents: [main('/repo', '/repo/.git')], query: 'repo' });
    const row = screen.getByTestId('project-switcher-recent-/repo');
    // Only the current-check may render a check; there is no folder icon.
    // (Not current here, so no svg at all on the project label.)
    expect(row.querySelector('svg')).toBeNull();
  });

  test('matches an opened worktree by branch name and opens it as a worktree', async () => {
    const { bridge } = renderMenu({
      recents: [
        main('/repo', '/repo/.git'),
        worktree('/repo/.ok/worktrees/dev', '/repo/.git', '/repo', 'dev'),
      ],
      query: 'dev',
    });
    // The result names the project (repo) the worktree belongs to.
    const row = screen.getByTestId('project-switcher-worktree-/repo/.ok/worktrees/dev');
    expect(row.textContent).toContain('dev');
    expect(row.textContent).toContain('repo');
    fireEvent.click(row);
    await waitFor(() => {
      expect(bridge.project.open).toHaveBeenCalledWith({
        path: '/repo/.ok/worktrees/dev',
        target: 'new-window',
        entryPoint: 'worktree',
      });
    });
  });

  test('matches an un-opened branch from the cached model and creates its worktree on demand', async () => {
    const { bridge } = renderMenu({
      query: 'feature',
      worktreeModel: model([
        { branch: 'feature-x', worktreePath: null, isCurrent: false, isMain: false, locked: false },
      ]),
    });
    // The row names the current project the branch belongs to.
    expect(screen.getByTestId('project-switcher-branch-feature-x').textContent).toContain('repo');
    fireEvent.click(screen.getByTestId('project-switcher-branch-feature-x'));
    await waitFor(() => {
      expect(bridge.worktree.create).toHaveBeenCalledWith({
        branch: 'feature-x',
        createBranch: false,
      });
    });
    await waitFor(() => {
      expect(bridge.project.open).toHaveBeenCalledWith({
        path: '/repo/.ok/worktrees/feature-x',
        target: 'new-window',
        entryPoint: 'worktree',
      });
    });
    expect(refreshWorktrees).toHaveBeenCalled();
  });

  test('does not double-list a branch already shown as an opened worktree', () => {
    renderMenu({
      recents: [worktree('/repo/.ok/worktrees/dev', '/repo/.git', '/repo', 'dev')],
      query: 'dev',
      worktreeModel: model([
        {
          branch: 'dev',
          worktreePath: '/repo/.ok/worktrees/dev',
          isCurrent: false,
          isMain: false,
          locked: false,
        },
      ]),
    });
    // Shown once as the opened worktree, not again as a create-on-demand branch.
    expect(screen.getByTestId('project-switcher-worktree-/repo/.ok/worktrees/dev')).not.toBeNull();
    expect(screen.queryByTestId('project-switcher-branch-dev')).toBeNull();
  });

  test('announces when nothing matches', () => {
    renderMenu({ recents: [main('/repo', '/repo/.git')], query: 'zzz-nothing' });
    expect(screen.getByRole('status').textContent).toBe('No matching projects.');
  });

  test('a failed create-on-demand toasts and does not open a window', async () => {
    toastError.mockClear();
    const bridge = createBridge();
    bridge.worktree.create = mock(() =>
      Promise.resolve({ ok: false as const, reason: 'branch-exists' as const }),
    );
    renderMenu({
      bridge,
      query: 'feature',
      worktreeModel: model([
        { branch: 'feature-x', worktreePath: null, isCurrent: false, isMain: false, locked: false },
      ]),
    });
    fireEvent.click(screen.getByTestId('project-switcher-branch-feature-x'));
    await waitFor(() => expect(bridge.worktree.create).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(bridge.project.open).not.toHaveBeenCalled();
  });
});
