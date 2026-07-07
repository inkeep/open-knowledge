/**
 * The recents + worktrees body of the ProjectSwitcher dropdown. Two modes:
 *   - No query: recents grouped by repo. A project with opened worktrees is a
 *     row with two click targets — the name/path opens the bare project (root
 *     git workspace), the right-side worktree-icon + count + chevron opens a
 *     side-flyout listing that project's worktrees + branches. A project with
 *     none is a plain row.
 *   - Query: a flat list of matches across recent projects, their opened
 *     worktrees, and the CURRENT project's branches (from the cached store, so
 *     an un-opened branch is reachable by typing its name — create-on-demand).
 *
 * The per-project worktree list is a Radix `Popover` side-flyout, NOT an inline
 * disclosure and NOT a Radix `DropdownMenuSub`: the Electron renderer delivers
 * no real `pointerdown`, so Radix submenus never open on click OR hover there
 * (the same missing-pointer-event family as the v1 top-level menu). A Popover
 * opens on click, which works. Its open-state is HOISTED to ProjectSwitcher
 * (one "which row's flyout is open" value) so the flyout renders as a single
 * controlled overlay rather than one deeply-nested overlay per menu item — two
 * stacked non-modal Radix overlays otherwise fight focus-return / outside-click
 * dismiss. See ProjectSwitcher for the hoist + the menu-vs-flyout dismiss guard.
 *
 * Opening a worktree reuses `project.open({ entryPoint: 'worktree' })`; creating
 * one for a branch that has no window yet goes through `worktree.create` first,
 * then refreshes the cached store. The `guardStaleSelect` from ProjectSwitcher
 * neutralizes the Electron open-click fall-through on every row.
 */

import type { WorktreeSelectorEntry, WorktreeSelectorModel } from '@inkeep/open-knowledge-core';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { Check, ChevronRight, GitBranch, Plus, Search } from 'lucide-react';
import type * as React from 'react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem, DropdownMenuLabel } from '@/components/ui/dropdown-menu';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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
  setFlyoutPath: (path: string | null) => void;
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
          setFlyoutOpen={(next) => setFlyoutPath(next ? group.project.path : null)}
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

  if (group.worktrees.length === 0) {
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
  flyoutOpen: boolean;
  setFlyoutOpen: (open: boolean) => void;
  onPickProject: () => void;
  onPickFlyoutEntry: (entry: WorktreeFlyoutEntry) => void;
  guardStaleSelect: (event: Event) => boolean;
  openNewWorktreeWith: (name: string) => void;
}) {
  const { t } = useLingui();
  const projectIsCurrent = group.project.path === currentPath;

  return (
    <Popover open={flyoutOpen} onOpenChange={setFlyoutOpen}>
      <DropdownMenuItem
        onSelect={(e) => {
          if (guardStaleSelect(e)) return;
          // Clicking the name/path opens the bare project (root git workspace);
          // the expander (its own click target below) opens the worktree flyout.
          onPickProject();
        }}
        // Keyboard access to the flyout (the count-chip trigger is tabIndex=-1,
        // out of the menu's roving focus). Standard submenu keys off the focused
        // row: Right opens the flyout (focus moves into its search input via the
        // Popover's open-autofocus), Left/Escape closes it. Only swallow
        // Left/Escape while the flyout is OPEN so a closed-flyout Escape still
        // bubbles to close the whole menu. This row only renders when the group
        // has worktrees, so a flyout always exists here.
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') {
            e.preventDefault();
            setFlyoutOpen(true);
          } else if ((e.key === 'ArrowLeft' || e.key === 'Escape') && flyoutOpen) {
            e.preventDefault();
            e.stopPropagation();
            setFlyoutOpen(false);
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
        {/* Separate click target: worktree icon + count + chevron opens the
          side-flyout. The PopoverTrigger IS this button. stopPropagation keeps
          the row's open-project select from also firing. tabIndex=-1 keeps it
          out of the menu's roving focus. */}
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            tabIndex={-1}
            aria-label={flyoutOpen ? t`Hide worktrees` : t`Show worktrees`}
            aria-expanded={flyoutOpen}
            onMouseDown={(e) => {
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.stopPropagation();
            }}
            // Open the flyout on HOVER, not just click. Mouse-enter DOES fire on
            // the Electron renderer (unlike pointerdown), so this works here. Only
            // OPEN on hover — deliberately NO onMouseLeave close: leaving the chip
            // to reach the portaled flyout must not dismiss it (that was the v1
            // "closes when I move my mouse" bug). It closes by hovering another
            // project's chip (single hoisted flyout switches), clicking the chip
            // again, Escape, picking an entry, or the menu closing.
            onMouseEnter={() => {
              setFlyoutOpen(true);
            }}
            data-testid={`project-switcher-toggle-${group.project.path}`}
            className="-my-1 -mr-1 h-auto shrink-0 gap-1 rounded-md px-1.5 py-1 text-muted-foreground hover:bg-accent-foreground/15 hover:text-foreground hover:ring-1 hover:ring-border hover:ring-inset"
          >
            {/* Worktree count + pluralized label ("3 worktrees" / "1 worktree").
              The digit stays tabular-nums so the count column doesn't jitter.
              No leading icon here — "worktrees" already says what this is. */}
            <span className="text-xs">
              <span className="tabular-nums">{group.worktrees.length}</span>{' '}
              <Plural value={group.worktrees.length} one="worktree" other="worktrees" />
            </span>
            <ChevronRight aria-hidden="true" className="size-3.5" />
          </Button>
        </PopoverTrigger>
      </DropdownMenuItem>
      <WorktreeFlyout
        group={group}
        currentPath={currentPath}
        worktreeModel={worktreeModel}
        onPickFlyoutEntry={onPickFlyoutEntry}
        guardStaleSelect={guardStaleSelect}
        openNewWorktreeWith={openNewWorktreeWith}
      />
    </Popover>
  );
}

/**
 * The side-flyout content for one project: a search box over that project's
 * worktrees + local branches, then the ordered list (main
 * pinned, opened worktrees by recency, create-on-demand branches last). Portals
 * out of the menu's scroll container so it isn't clipped.
 */
function WorktreeFlyout({
  group,
  currentPath,
  worktreeModel,
  onPickFlyoutEntry,
  guardStaleSelect,
  openNewWorktreeWith,
}: {
  group: RecentRepoGroup;
  currentPath: string;
  worktreeModel: WorktreeSelectorModel | null;
  onPickFlyoutEntry: (entry: WorktreeFlyoutEntry) => void;
  guardStaleSelect: (event: Event) => boolean;
  openNewWorktreeWith: (name: string) => void;
}) {
  const { t } = useLingui();
  const [flyoutQuery, setFlyoutQuery] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Manual roving focus over the entry rows. These rows are Radix
  // DropdownMenuItems inside a PORTALED PopoverContent — NOT a real DropdownMenu
  // roving-focus context — so Radix's built-in arrow-key roving does not reach
  // them. We drive focus ourselves off the live DOM (`[role="menuitem"]` in the
  // list container) rather than a parallel ref array, so it stays correct as the
  // search filters the list. ArrowDown out of the search input enters the list;
  // ArrowUp off the first row returns to the search input.
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
  // Escape / ArrowLeft are intentionally NOT handled so the Popover's own
  // Escape-to-close (and the group row's keys) keep working.
  function onRowKeyDown(e: React.KeyboardEvent, onEnter: () => void): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const rows = focusableRows();
      const i = rows.indexOf(e.currentTarget as HTMLElement);
      focusRowAt(Math.min(i + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const rows = focusableRows();
      const i = rows.indexOf(e.currentTarget as HTMLElement);
      if (i <= 0) searchRef.current?.focus();
      else focusRowAt(i - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onEnter();
    }
  }

  const entries = buildWorktreeFlyoutEntries(group, worktreeModel, currentPath);
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
    <PopoverContent
      side="right"
      align="start"
      sideOffset={4}
      className="flex max-h-80 w-96 flex-col gap-1 overflow-hidden p-1"
      // Two stacked non-modal Radix overlays (menu + this flyout) otherwise
      // fight over outside-click dismiss: a click inside this portaled flyout
      // reads as "outside the menu" and closes both. Stopping the pointerdown
      // here keeps the flyout interactive without collapsing the menu behind it.
      // (Live dismiss behavior is only verifiable on the Electron renderer.)
      onPointerDownOutside={(e) => e.preventDefault()}
      // The flyout lives inside a Radix DropdownMenuItem; the parent menu focuses
      // whatever row the pointer moves over (menus focus-on-hover), pulling focus
      // OUT of this flyout — which would dismiss it the instant the mouse leaves
      // the trigger, making it impossible to mouse in. Preventing the focus-outside
      // dismiss keeps it open; it still closes on trigger re-click, Escape, picking
      // an entry, or the menu closing (hoisted flyout state).
      onFocusOutside={(e) => e.preventDefault()}
      // Keyboard access: when the flyout opens (via ArrowRight on the
      // group row, or click), move focus INTO it — onto the search input — so the
      // list + "Create worktree" option are keyboard-reachable. Preventing Radix's
      // default auto-focus lets us pick the target deterministically. Focus lands
      // INSIDE the flyout, so the onFocusOutside guard above never fires (it stays
      // open); Escape from here is handled by the Popover (close + return focus).
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        searchRef.current?.focus();
      }}
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
          // the stop keeps the parent menu's typeahead from stealing the keys,
          // but would also swallow ArrowDown, so nav has to run first. Escape /
          // ArrowLeft are left to the Popover / group row, unchanged.
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              focusRowAt(0);
            }
            e.stopPropagation();
          }}
          data-testid={`project-switcher-flyout-search-${group.project.path}`}
        />
        {/* Branch icon trails as the worktree-context cue (kept per design),
          alongside the leading search magnifier. */}
        <InputGroupAddon align="inline-end">
          <GitBranch aria-hidden="true" />
        </InputGroupAddon>
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
    </PopoverContent>
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
