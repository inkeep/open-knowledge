/**
 * The recents + worktrees body of the ProjectSwitcher dropdown. Two modes:
 *   - No query: recents grouped by repo. A project with opened worktrees is a
 *     two-target submenu row: HOVERING it (or ArrowRight) opens a side-flyout
 *     listing that project's worktrees + branches, while CLICKING it (or
 *     Enter/Space) opens the bare project (root git workspace) directly — one
 *     click, same as a flat row. A project with no opened worktrees is a plain
 *     row that opens it directly.
 *   - Query: a flat list of matches across recent projects, their opened
 *     worktrees, and the CURRENT project's branches (from the cached store, so
 *     an un-opened branch is reachable by typing its name — create-on-demand).
 *
 * The per-project worktree list is a Radix `DropdownMenuSub` (shadcn
 * `DropdownMenuSub`/`SubTrigger`/`SubContent`) — a real submenu of the project
 * dropdown, so mouse traversal gets Radix's safe-triangle hover and the flyout
 * closes when the pointer leaves both the row and the flyout. An earlier
 * revision used a Popover here on the theory that the Electron renderer's
 * missing `pointerdown` broke Radix submenus; live testing showed submenus open
 * on `pointermove`/`click` (only drag-region title-bar triggers are affected,
 * and this trigger sits inside the portaled, non-drag menu). Its open-state is
 * still HOISTED to ProjectSwitcher (one "which row's flyout is open" value) so
 * only one is open at a time and the parent can force-close it on menu dismiss
 * and on parent-menu scroll — Radix anchors the submenu to its trigger and would
 * otherwise follow the row off-screen. See ProjectSwitcher for the hoist + the
 * scroll-close.
 *
 * Opening a worktree reuses `project.open({ entryPoint: 'worktree' })`; creating
 * one for a branch that has no window yet goes through `worktree.create` first,
 * then refreshes the cached store. The `guardStaleSelect` from ProjectSwitcher
 * neutralizes the Electron open-click fall-through on every row.
 */

import type { WorktreeSelectorEntry, WorktreeSelectorModel } from '@inkeep/open-knowledge-core';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { Check, GitBranch, Plus, Search } from 'lucide-react';
import type * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import type { OkDesktopBridge, RecentProjectEntry } from '@/lib/desktop-bridge-types';
import { cn } from '@/lib/utils';
import { refreshWorktrees } from '@/lib/worktree-store';
import {
  basenameOf,
  buildWorktreeFlyoutEntries,
  groupRecentsByRepo,
  type RecentRepoGroup,
  type WorktreeFlyoutEntry,
} from './project-switcher-recents';

interface RecentProjectsMenuProps {
  bridge: OkDesktopBridge;
  recents: readonly RecentProjectEntry[];
  /** The current window's project path (marked with a check, no-op on select). */
  currentPath: string;
  /** Trimmed, lowercased search query ('' = grouped browse mode). */
  query: string;
  /** Cached worktree model for the current project (all branches), or null. */
  worktreeModel: WorktreeSelectorModel | null;
  closeMenu: () => void;
  /** Swallows the Electron open-click fall-through (see ProjectSwitcher). */
  guardStaleSelect: (event: Event) => boolean;
  /**
   * Hoisted "which project row's worktree flyout is open" (its `project.path`),
   * or null. Lives in ProjectSwitcher so only one flyout is open at a time and
   * the parent can force-close it when the menu dismisses.
   */
  flyoutPath: string | null;
  setFlyoutPath: React.Dispatch<React.SetStateAction<string | null>>;
  /**
   * Opens the New Worktree dialog pre-filled with `name` (the flyout's typed
   * query). Wired from the current project's flyout no-match "Create worktree …"
   * option — creation anchors to the current window's project, so it's only
   * offered there (see WorktreeFlyout).
   */
  openNewWorktreeWith: (name: string) => void;
}

export function RecentProjectsMenu({
  bridge,
  recents,
  currentPath,
  query,
  worktreeModel,
  closeMenu,
  guardStaleSelect,
  flyoutPath,
  setFlyoutPath,
  openNewWorktreeWith,
}: RecentProjectsMenuProps) {
  const { t } = useLingui();

  function openPath(path: string, entryPoint: 'recents' | 'worktree'): void {
    closeMenu();
    void bridge.project.open({ path, target: 'new-window', entryPoint }).catch((err) => {
      console.warn('[RecentProjectsMenu] project.open failed:', err);
      toast.error(t`Failed to open.`);
    });
  }

  async function createAndOpenBranch(branch: string): Promise<void> {
    try {
      const result = await bridge.worktree.create({ branch, createBranch: false });
      if (!result.ok) {
        toast.error(t`Couldn't open a worktree for that branch.`);
        return;
      }
      refreshWorktrees();
      await bridge.project.open({
        path: result.path,
        target: 'new-window',
        entryPoint: 'worktree',
      });
    } catch (err) {
      console.warn('[RecentProjectsMenu] create/open branch failed:', err);
      toast.error(t`Failed to open worktree.`);
    }
  }

  function onPickEntry(entry: RecentProjectEntry): void {
    if (entry.path === currentPath) {
      closeMenu();
      return;
    }
    openPath(entry.path, entry.isLinkedWorktree ? 'worktree' : 'recents');
  }

  function onPickFlyoutEntry(entry: WorktreeFlyoutEntry): void {
    if (entry.path !== null) {
      if (entry.path === currentPath) {
        closeMenu();
        return;
      }
      openPath(entry.path, entry.isMain ? 'recents' : 'worktree');
      return;
    }
    // No worktree yet → create one on demand for this branch, then open it.
    if (entry.branch !== null) {
      closeMenu();
      void createAndOpenBranch(entry.branch);
    }
  }

  if (query !== '') {
    return (
      <SearchResults
        recents={recents}
        currentPath={currentPath}
        query={query}
        worktreeModel={worktreeModel}
        onPickEntry={onPickEntry}
        onPickBranch={(branch) => {
          closeMenu();
          void createAndOpenBranch(branch);
        }}
        guardStaleSelect={guardStaleSelect}
      />
    );
  }

  const groups = groupRecentsByRepo(recents);
  return (
    <>
      {groups.map((group) => (
        <GroupRow
          key={group.project.path}
          group={group}
          currentPath={currentPath}
          worktreeModel={worktreeModel}
          flyoutOpen={flyoutPath === group.project.path}
          // Native hover-out-close can fire a sibling's A-close and this row's
          // B-open in the same tick; a functional update guards against a stale
          // close clobbering a fresh open (only clear if THIS row is the open one).
          setFlyoutOpen={(next) =>
            setFlyoutPath((cur) =>
              next ? group.project.path : cur === group.project.path ? null : cur,
            )
          }
          onPickProject={() => {
            if (group.project.path === currentPath) {
              closeMenu();
              return;
            }
            openPath(group.project.path, 'recents');
          }}
          onPickFlyoutEntry={onPickFlyoutEntry}
          guardStaleSelect={guardStaleSelect}
          openNewWorktreeWith={openNewWorktreeWith}
        />
      ))}
    </>
  );
}

function GroupRow({
  group,
  currentPath,
  worktreeModel,
  flyoutOpen,
  setFlyoutOpen,
  onPickProject,
  onPickFlyoutEntry,
  guardStaleSelect,
  openNewWorktreeWith,
}: {
  group: RecentRepoGroup;
  currentPath: string;
  worktreeModel: WorktreeSelectorModel | null;
  flyoutOpen: boolean;
  setFlyoutOpen: (open: boolean) => void;
  onPickProject: () => void;
  onPickFlyoutEntry: (entry: WorktreeFlyoutEntry) => void;
  guardStaleSelect: (event: Event) => boolean;
  openNewWorktreeWith: (name: string) => void;
}) {
  const projectIsCurrent = group.project.path === currentPath;

  // Single source for BOTH the count chip and the flyout affordance: the same
  // builder rows the flyout list is built from, so the chip and the list can't
  // drift apart on which worktrees exist. We count opened, non-main worktrees —
  // the main checkout is pinned in the flyout as "default" and isn't itself a
  // switchable worktree — which matches the pre-migration `group.worktrees.length`
  // semantic while sourcing it from the git model (an opened worktree the model
  // knows about but Recents doesn't now surfaces the affordance). Hoisted here so
  // the builder runs once per group.
  const flyoutEntries = buildWorktreeFlyoutEntries(group, worktreeModel, currentPath);
  const openedWorktreeCount = flyoutEntries.filter((e) => e.opened && !e.isMain).length;

  if (openedWorktreeCount === 0) {
    return (
      <DropdownMenuItem
        onSelect={(e) => {
          if (guardStaleSelect(e)) return;
          onPickProject();
        }}
        className="flex w-full min-w-0 flex-col items-start gap-0.5"
        data-testid={`project-switcher-recent-${group.project.path}`}
        data-current={projectIsCurrent ? 'true' : undefined}
      >
        <ProjectLabel
          name={group.project.name}
          path={group.project.path}
          current={projectIsCurrent}
        />
      </DropdownMenuItem>
    );
  }

  const containsCurrent = projectIsCurrent || group.worktrees.some((w) => w.path === currentPath);
  return (
    <FlyoutGroup
      group={group}
      currentPath={currentPath}
      containsCurrent={containsCurrent}
      worktreeModel={worktreeModel}
      flyoutEntries={flyoutEntries}
      openedWorktreeCount={openedWorktreeCount}
      flyoutOpen={flyoutOpen}
      setFlyoutOpen={setFlyoutOpen}
      onPickProject={onPickProject}
      onPickFlyoutEntry={onPickFlyoutEntry}
      guardStaleSelect={guardStaleSelect}
      openNewWorktreeWith={openNewWorktreeWith}
    />
  );
}

function FlyoutGroup({
  group,
  currentPath,
  containsCurrent,
  worktreeModel,
  flyoutEntries,
  openedWorktreeCount,
  flyoutOpen,
  setFlyoutOpen,
  onPickProject,
  onPickFlyoutEntry,
  guardStaleSelect,
  openNewWorktreeWith,
}: {
  group: RecentRepoGroup;
  currentPath: string;
  containsCurrent: boolean;
  worktreeModel: WorktreeSelectorModel | null;
  /** Builder rows, hoisted from GroupRow so the builder runs once per group. */
  flyoutEntries: WorktreeFlyoutEntry[];
  /** Opened, non-main worktree count from the same builder — drives the chip. */
  openedWorktreeCount: number;
  flyoutOpen: boolean;
  setFlyoutOpen: (open: boolean) => void;
  onPickProject: () => void;
  onPickFlyoutEntry: (entry: WorktreeFlyoutEntry) => void;
  guardStaleSelect: (event: Event) => boolean;
  openNewWorktreeWith: (name: string) => void;
}) {
  const { t } = useLingui();
  const projectIsCurrent = group.project.path === currentPath;

  // Two-target row on a real submenu (restores the pre-migration ergonomics):
  //   - HOVER anywhere on the row opens the worktree flyout (native Radix
  //     safe-triangle + close-on-leave-both), and ArrowRight opens it by keyboard.
  //   - CLICK / Enter / Space open the PROJECT (its root) directly — one click,
  //     same as a flat row. Radix's SubTrigger opens the submenu on click and on
  //     the SUB_OPEN_KEYS (Enter/Space/ArrowRight); it bails when our handler
  //     already called preventDefault (onClick: `if (event.defaultPrevented) return`;
  //     onKeyDown: composed with checkForDefaultPrevented), so preventing default
  //     on click + Enter/Space suppresses the open and lets navigation win while
  //     ArrowRight still falls through to open the flyout. guardStaleSelect
  //     swallows the Electron menu-open click fall-through, as on the flat rows.
  const openProjectFromRow = (nativeEvent: Event): void => {
    if (guardStaleSelect(nativeEvent)) return;
    onPickProject();
  };
  return (
    <DropdownMenuSub open={flyoutOpen} onOpenChange={setFlyoutOpen}>
      <DropdownMenuSubTrigger
        onClick={(e) => {
          e.preventDefault();
          openProjectFromRow(e.nativeEvent);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openProjectFromRow(e.nativeEvent);
          }
        }}
        className="flex w-full min-w-0 items-start gap-2"
        data-testid={`project-switcher-group-${group.project.path}`}
        data-flyout-open={flyoutOpen ? 'true' : undefined}
        data-current={containsCurrent ? 'true' : undefined}
      >
        {/* Two lines (name + path), matching the flat rows — the path
          disambiguates same-named checkouts. No folder icon: the switcher stays
          focused on project names, reclaiming the horizontal space. */}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate font-medium text-sm" title={group.project.name}>
            {group.project.name}
          </span>
          <span className="truncate text-muted-foreground text-xs" title={group.project.path}>
            {group.project.path}
          </span>
        </span>
        {projectIsCurrent ? (
          <Check
            aria-label={t`Current`}
            className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
          />
        ) : null}
        {/* Opened, non-main worktree count + pluralized label ("3 worktrees" /
          "1 worktree"), counted off the same builder rows the flyout list is
          built from (so the chip tracks the same worktree set the list shows;
          the list additionally renders the pinned "default" + create-on-demand
          branches, which the chip deliberately doesn't count). The digit stays
          tabular-nums so the count column doesn't jitter; the disclosure chevron
          is supplied by DropdownMenuSubTrigger. No leading icon — "worktrees"
          already says what this is. */}
        <span
          className="mt-0.5 shrink-0 text-muted-foreground text-xs"
          data-testid={`project-switcher-toggle-${group.project.path}`}
        >
          <span className="tabular-nums">{openedWorktreeCount}</span>{' '}
          <Plural value={openedWorktreeCount} one="worktree" other="worktrees" />
        </span>
      </DropdownMenuSubTrigger>
      <WorktreeFlyout
        group={group}
        open={flyoutOpen}
        worktreeModel={worktreeModel}
        entries={flyoutEntries}
        onPickFlyoutEntry={onPickFlyoutEntry}
        guardStaleSelect={guardStaleSelect}
        openNewWorktreeWith={openNewWorktreeWith}
      />
    </DropdownMenuSub>
  );
}

/**
 * The side-flyout content for one project: a search box over that project's
 * worktrees + local branches, then the ordered list (main pinned, opened
 * worktrees by recency, create-on-demand branches last). Rendered as a
 * DropdownMenuSubContent — a real submenu, so it isn't clipped by the parent
 * menu's scroll container (Radix positions it fixed against the trigger).
 */
function WorktreeFlyout({
  group,
  open,
  worktreeModel,
  entries,
  onPickFlyoutEntry,
  guardStaleSelect,
  openNewWorktreeWith,
}: {
  group: RecentRepoGroup;
  /** Hoisted open state — drives the focus-into-search effect on open. */
  open: boolean;
  worktreeModel: WorktreeSelectorModel | null;
  /** Builder rows, hoisted from GroupRow so the builder runs once per group. */
  entries: WorktreeFlyoutEntry[];
  onPickFlyoutEntry: (entry: WorktreeFlyoutEntry) => void;
  guardStaleSelect: (event: Event) => boolean;
  openNewWorktreeWith: (name: string) => void;
}) {
  const { t } = useLingui();
  const [flyoutQuery, setFlyoutQuery] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Move focus onto the search input when the submenu opens so the list + the
  // "Create worktree" option are keyboard-reachable. DropdownMenuSubContent
  // hardcodes its own onOpenAutoFocus (a passed one is ignored), so drive focus
  // from the open transition instead. The content — and this input — only mounts
  // while open, so searchRef is live by the time this runs, and it lands after
  // Radix's own focus so the input wins. `preventScroll` so focusing the input
  // can't nudge the parent recents scroll container, whose onScroll close would
  // otherwise self-dismiss the flyout the instant it opens.
  useEffect(() => {
    if (open) searchRef.current?.focus({ preventScroll: true });
  }, [open]);

  // Manual roving focus over the entry rows. `preventDefault` + `stopPropagation`
  // on the keys we own keeps the enclosing DropdownMenuSubContent's native
  // roving/typeahead from also acting on them; ArrowLeft / Escape are left to
  // bubble so Radix closes the submenu. We drive focus off the live DOM
  // (`[role="menuitem"]` in the list container) rather than a parallel ref array,
  // so it stays correct as the search filters the list. ArrowDown out of the
  // search input enters the list; ArrowUp off the first row returns to it.
  function focusableRows(): HTMLElement[] {
    const container = listRef.current;
    if (container === null) return [];
    return [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  }
  function focusRowAt(index: number): void {
    const rows = focusableRows();
    rows[index]?.focus();
  }
  // Roving handler shared by every list row: Up/Down move between rows, Up off
  // the first row returns to the search input, Enter fires the row's action.
  // Escape / ArrowLeft are intentionally NOT handled so DropdownMenuSubContent's
  // native ArrowLeft/Escape (close the submenu, close the menu) keep working.
  function onRowKeyDown(e: React.KeyboardEvent, onEnter: () => void): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      const rows = focusableRows();
      const i = rows.indexOf(e.currentTarget as HTMLElement);
      focusRowAt(Math.min(i + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const rows = focusableRows();
      const i = rows.indexOf(e.currentTarget as HTMLElement);
      if (i <= 0) searchRef.current?.focus();
      else focusRowAt(i - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      onEnter();
    }
  }

  const q = flyoutQuery.trim().toLowerCase();
  const visible =
    q === '' ? entries : entries.filter((e) => (e.branch ?? '').toLowerCase().includes(q));
  // "Create worktree …" is only meaningful for the CURRENT project: creation
  // anchors to the current window (branch create-on-demand + `worktree.create`
  // both use the current project's model), so offering it in another project's
  // flyout would silently create the worktree in the wrong project. Match the
  // `isCurrentModel` predicate in buildWorktreeFlyoutEntries.
  const isCurrentProject =
    worktreeModel !== null && worktreeModel.mainRoot === group.project.mainRoot;
  const typedName = flyoutQuery.trim();
  const canCreate = isCurrentProject && typedName.length > 0;

  return (
    <DropdownMenuSubContent
      sideOffset={4}
      className="flex max-h-80 w-96 flex-col gap-1 overflow-hidden p-1"
      data-testid={`project-switcher-flyout-${group.project.path}`}
    >
      <InputGroup className="mb-1 h-8 shrink-0">
        {/* Search magnifier leads so the row reads as a typeable field; the
          default InputGroup border + focus ring (restored by dropping the
          border-0 / ring-0 overrides) is what signals "you can type here". */}
        <InputGroupAddon align="inline-start">
          <Search aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput
          ref={searchRef}
          aria-label={t`Search worktrees and branches`}
          placeholder={t`Search worktrees`}
          value={flyoutQuery}
          onChange={(e) => setFlyoutQuery(e.target.value)}
          // ArrowDown steps from the search box into the entry list (focus the
          // first row); typing still filters. Intercept BEFORE stopPropagation —
          // the stop keeps the enclosing submenu's typeahead/roving from stealing
          // the keys, but would also swallow ArrowDown, so nav has to run first.
          // Escape still closes (Radix's document-level dismiss ignores React
          // stopPropagation); ArrowLeft stays a cursor move inside the input.
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              focusRowAt(0);
            }
            e.stopPropagation();
          }}
          data-testid={`project-switcher-flyout-search-${group.project.path}`}
        />
      </InputGroup>
      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain subtle-scrollbar"
      >
        {visible.length === 0 ? (
          <>
            <DropdownMenuLabel
              className="font-normal text-muted-foreground text-xs"
              role="status"
              aria-live="polite"
            >
              {t`No matching worktrees or branches.`}
            </DropdownMenuLabel>
            {/* No match, but a name was typed — offer to create a worktree with
              it. Only for the current project (creation anchors to the current
              window). Closes the switcher + opens the pre-filled dialog. */}
            {canCreate ? (
              <DropdownMenuItem
                onSelect={(e) => {
                  if (guardStaleSelect(e)) return;
                  openNewWorktreeWith(typedName);
                }}
                onKeyDown={(e) => onRowKeyDown(e, () => openNewWorktreeWith(typedName))}
                className="flex items-center gap-2"
                data-testid="project-switcher-flyout-create"
              >
                <Plus aria-hidden="true" className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-sm" title={typedName}>
                  <Trans>
                    Create worktree{' '}
                    <span className="font-medium">
                      “<span className="font-mono">{typedName}</span>”
                    </span>
                  </Trans>
                </span>
              </DropdownMenuItem>
            ) : null}
          </>
        ) : (
          visible.map((entry) => {
            const key = entry.path ?? `branch:${entry.branch}`;
            const label = entry.branch ?? t`(detached)`;
            return (
              <DropdownMenuItem
                key={key}
                onSelect={(e) => {
                  if (guardStaleSelect(e)) return;
                  onPickFlyoutEntry(entry);
                }}
                onKeyDown={(e) => onRowKeyDown(e, () => onPickFlyoutEntry(entry))}
                className="flex items-center gap-2"
                data-testid={`project-switcher-flyout-entry-${key}`}
                data-current={entry.isCurrent ? 'true' : undefined}
              >
                <span className="min-w-0 flex-1 truncate text-sm" title={label}>
                  {label}
                </span>
                {entry.isMain ? (
                  <span className="shrink-0 text-muted-foreground text-xs">{t`default`}</span>
                ) : !entry.opened ? (
                  <span
                    className="shrink-0 text-muted-foreground text-xs"
                    title={t`Create a worktree from this branch`}
                  >
                    {t`create worktree`}
                  </span>
                ) : null}
                {entry.isCurrent ? <CurrentCheck /> : null}
              </DropdownMenuItem>
            );
          })
        )}
      </div>
    </DropdownMenuSubContent>
  );
}

function SearchResults({
  recents,
  currentPath,
  query,
  worktreeModel,
  onPickEntry,
  onPickBranch,
  guardStaleSelect,
}: {
  recents: readonly RecentProjectEntry[];
  currentPath: string;
  query: string;
  worktreeModel: WorktreeSelectorModel | null;
  onPickEntry: (entry: RecentProjectEntry) => void;
  onPickBranch: (branch: string) => void;
  guardStaleSelect: (event: Event) => boolean;
}) {
  const { t } = useLingui();
  const matches = (text: string): boolean => text.toLowerCase().includes(query);

  const projectMatches = recents.filter(
    (r) => !r.isLinkedWorktree && (matches(r.name) || matches(r.path)),
  );
  const openedWorktreeMatches = recents.filter(
    (r) => r.isLinkedWorktree === true && (matches(r.branch ?? '') || matches(r.path)),
  );
  const openedWorktreePaths = new Set(openedWorktreeMatches.map((w) => w.path));
  // Current project's branches (cached store) matching — excluding ones already
  // shown as opened worktrees so the same branch isn't listed twice.
  const branchMatches: WorktreeSelectorEntry[] = (worktreeModel?.entries ?? []).filter(
    (e) =>
      e.branch !== null &&
      matches(e.branch) &&
      (e.worktreePath === null || !openedWorktreePaths.has(e.worktreePath)) &&
      e.worktreePath !== currentPath,
  );

  if (
    projectMatches.length === 0 &&
    openedWorktreeMatches.length === 0 &&
    branchMatches.length === 0
  ) {
    return (
      <DropdownMenuLabel
        className="font-normal text-muted-foreground text-xs"
        role="status"
        aria-live="polite"
      >
        {t`No matching projects.`}
      </DropdownMenuLabel>
    );
  }

  return (
    <>
      {projectMatches.map((r) => (
        <DropdownMenuItem
          key={r.path}
          onSelect={(e) => {
            if (guardStaleSelect(e)) return;
            onPickEntry(r);
          }}
          className="flex w-full min-w-0 flex-col items-start gap-0.5"
          data-testid={`project-switcher-recent-${r.path}`}
        >
          <ProjectLabel name={r.name} path={r.path} current={r.path === currentPath} />
        </DropdownMenuItem>
      ))}
      {openedWorktreeMatches.map((r) => (
        <DropdownMenuItem
          key={r.path}
          onSelect={(e) => {
            if (guardStaleSelect(e)) return;
            onPickEntry(r);
          }}
          className="flex items-start gap-2"
          data-testid={`project-switcher-worktree-${r.path}`}
          data-current={r.path === currentPath ? 'true' : undefined}
        >
          <GitBranch aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <WorktreeResultLabel
            branch={r.branch ?? r.name}
            project={r.mainRoot !== undefined ? basenameOf(r.mainRoot) : null}
          />
        </DropdownMenuItem>
      ))}
      {branchMatches.map((e) => (
        <DropdownMenuItem
          key={`branch:${e.branch}`}
          onSelect={(ev) => {
            if (guardStaleSelect(ev)) return;
            if (e.branch !== null) onPickBranch(e.branch);
          }}
          className="flex items-start gap-2"
          data-testid={`project-switcher-branch-${e.branch}`}
        >
          <GitBranch aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 opacity-40" />
          <WorktreeResultLabel
            branch={e.branch ?? ''}
            project={worktreeModel !== null ? basenameOf(worktreeModel.mainRoot) : null}
            hint={t`create worktree`}
          />
        </DropdownMenuItem>
      ))}
    </>
  );
}

/**
 * A worktree/branch search result: the branch name over a muted line naming the
 * project (repo) it belongs to, so `crdt` matching a worktree makes it obvious
 * which project that worktree lives under. `hint` (e.g. "create") flags a branch
 * with no worktree yet.
 */
function WorktreeResultLabel({
  branch,
  project,
  hint,
}: {
  branch: string;
  project: string | null;
  hint?: string;
}) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex w-full min-w-0 items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-sm">{branch}</span>
        {hint !== undefined ? (
          <span className="shrink-0 text-muted-foreground text-xs">{hint}</span>
        ) : null}
      </span>
      {project !== null ? (
        <span className="truncate text-muted-foreground text-xs" title={project}>
          {project}
        </span>
      ) : null}
    </span>
  );
}

function ProjectLabel({ name, path, current }: { name: string; path: string; current: boolean }) {
  return (
    <span className="flex w-full min-w-0 flex-col gap-0.5">
      <span className={cn('flex w-full items-center gap-1.5', current && 'font-medium')}>
        <span className="truncate font-medium text-sm" title={name}>
          {name}
        </span>
        {current ? (
          <Check aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        ) : null}
      </span>
      <span className="w-full truncate text-muted-foreground text-xs" title={path}>
        {path}
      </span>
    </span>
  );
}

function CurrentCheck() {
  const { t } = useLingui();
  return <Check aria-label={t`Current`} className="size-3.5 shrink-0 text-muted-foreground" />;
}
