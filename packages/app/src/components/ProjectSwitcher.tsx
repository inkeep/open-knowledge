/**
 * ProjectSwitcher — Electron-only UI affordance in the sidebar footer for
 * switching between projects. Renders as a compact pill showing the current
 * project name; clicking opens a dropdown (upward, into the sidebar) with:
 *   - Recents (from `bridge.project.listRecent()`), opens each in a new window
 *   - "Open folder" — native picker → open in a new window
 *
 * Web / CLI distribution does NOT render this — it's gated on
 * `window.okDesktop` being present. Without a window manager the concept
 * of "switch project" collapses to opening a new browser tab manually.
 *
 * Opening a recent project spawns a NEW editor BrowserWindow.
 * The current window is untouched — users end up with N windows, one per
 * project, and can close the current one if they only want the new project.
 * This matches the menu bar's File → Open Recent behavior; the UI control
 * is a discoverable surface for the same set of actions.
 */

import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronsUpDown, FolderOpen, GitBranch, LayoutGrid, Plus, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { SidebarMenuButton } from '@/components/ui/sidebar';
import { useCurrentBranch } from '@/hooks/use-current-branch';
import { useWorktrees } from '@/hooks/use-worktrees';
import type { OkDesktopBridge, RecentProjectEntry } from '@/lib/desktop-bridge-types';
import { runWithToast as runWithToastBase } from '@/lib/error-state';
import { cn } from '@/lib/utils';
import { CreateProjectDialog } from './CreateProjectDialog';
import { NewWorktreeDialog } from './NewWorktreeDialog';
import { RecentProjectsMenu } from './RecentProjectsMenu';

/**
 * Backward-compat re-export of the shared helper with this component's log
 * prefix baked in — existing tests import `runWithToast` from this module.
 * The shared helper moved to `@/lib/error-state` once a second consumer
 * (CommandPalette) landed.
 */
export const runWithToast = (
  fn: () => Promise<void>,
  fallback: string,
  toastApi?: { error(msg: string): void },
): Promise<void> => runWithToastBase(fn, fallback, toastApi, 'ProjectSwitcher');

/**
 * On the Electron host, Chromium delivers no real `pointerdown` to the renderer
 * (only `mousedown`/`click`), so Radix can't run its normal
 * open-gesture-vs-item-select tracking. The result: the same click that opens
 * this dropdown can fall through onto a menu row and immediately fire its
 * `onSelect` — the row's action runs (a project opens) and the menu closes
 * (it "flickers"). Any selection landing within this window of the menu
 * opening is treated as that accidental fall-through and swallowed; a
 * deliberate, later click still works. Mirrors the trigger's
 * onPointerDown/onClick workaround, applied to item selection.
 */
const SELECT_GUARD_MS = 350;

interface ProjectSwitcherProps {
  bridge: OkDesktopBridge;
}

export function ProjectSwitcher({ bridge }: ProjectSwitcherProps) {
  const { t } = useLingui();
  // `null` = the first `listRecent()` hasn't resolved yet (not-yet-loaded);
  // `[]` = loaded and genuinely empty. The distinction is load-bearing: the
  // menu must not flash "No recent projects." during the fetch on first open
  // (that empty label is only correct once we KNOW the list is empty).
  const [recents, setRecents] = useState<RecentProjectEntry[] | null>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [newWorktreeOpen, setNewWorktreeOpen] = useState(false);
  // Branch name to pre-fill the New Worktree dialog with. Set when the create
  // action fires from a flyout's "Create worktree …" no-match option (the typed
  // query); reset to '' by the standalone launchers so they open empty.
  const [newWorktreeInitialName, setNewWorktreeInitialName] = useState('');
  // Which project row's worktree side-flyout is open (its `project.path`), or
  // null. Hoisted here (rather than local per-row state in RecentProjectsMenu)
  // so only one flyout is open at a time and it force-closes when the menu
  // dismisses — the mitigation for two stacked non-modal Radix overlays.
  const [flyoutPath, setFlyoutPath] = useState<string | null>(null);
  const branch = useCurrentBranch();
  // Cached worktree model for the current project (one git spawn on mount,
  // shared with the command palette). Feeds the switcher's search so an
  // un-opened branch is reachable by name; null until it lands / off-desktop.
  const worktreeModel = useWorktrees();

  const isElectronHost = typeof window !== 'undefined' && window.okDesktop != null;
  // Tracks whether a real `pointerdown` reached the trigger this interaction.
  // See the trigger's onPointerDown/onClick for why opening from click is
  // load-bearing on the Electron host.
  const sawPointerDownRef = useRef(false);
  // True for SELECT_GUARD_MS after the menu opens, consumed by
  // `guardStaleSelect`. A boolean + timer (not a `Date.now()` timestamp)
  // because React Compiler rejects `Date.now()` as impure in a component
  // (see ActivityModeContent for the same constraint).
  const withinOpenGuardRef = useRef(false);
  const openGuardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleOpenChange = (next: boolean): void => {
    if (next) {
      withinOpenGuardRef.current = true;
      if (openGuardTimerRef.current !== null) clearTimeout(openGuardTimerRef.current);
      openGuardTimerRef.current = setTimeout(() => {
        withinOpenGuardRef.current = false;
      }, SELECT_GUARD_MS);
    }
    setOpen(next);
    // Drop the query + any open worktree flyout when the menu closes so the
    // next open starts clean (the lazy listRecent refetch already happens on
    // open). Force-closing the flyout here is the second half of the
    // stacked-overlay mitigation (the first is hoisting the state).
    if (!next) {
      setSearch('');
      setFlyoutPath(null);
    }
  };

  // True (and prevents the menu from closing) when a row's `onSelect` fired
  // within the guard window of the menu opening — the Electron open-click
  // fall-through. Browsers keep normal behavior (gated on the Electron host).
  const guardStaleSelect = (event: Event): boolean => {
    if (!isElectronHost || !withinOpenGuardRef.current) return false;
    event.preventDefault();
    return true;
  };

  // Lazy-load recents when the dropdown opens. Keeps initial render cheap
  // and always shows the latest list rather than a stale snapshot from mount.
  // IPC rejection surfaces as a toast so the user knows the list is stale
  // (rather than silently seeing an empty dropdown).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void runWithToast(async () => {
      const result = await bridge.project.listRecent();
      if (!cancelled) setRecents(result);
    }, t`Failed to load recent projects.`);
    return () => {
      cancelled = true;
    };
  }, [open, bridge, t]);

  // File menu → worktree items delegate here (worktree = window).
  // `new-worktree` opens the create dialog; `switch-worktree` opens this
  // dropdown (which lazy-loads the worktree list).
  useEffect(() => {
    return bridge.onMenuAction((action) => {
      if (action === 'new-worktree') {
        setOpen(false);
        setFlyoutPath(null);
        setNewWorktreeInitialName('');
        setNewWorktreeOpen(true);
      } else if (action === 'switch-worktree') {
        setOpen(true);
      }
    });
  }, [bridge]);

  const onOpenFolder = () => {
    handleOpenChange(false);
    void runWithToast(async () => {
      const path = await bridge.dialog.openFolder();
      if (!path) return;
      await bridge.project.open({ path, target: 'new-window', entryPoint: 'pick-existing' });
    }, t`Failed to open folder.`);
  };

  const onSwitchProject = () => {
    handleOpenChange(false);
    void runWithToast(() => bridge.navigator.open(), t`Failed to open Project Navigator.`);
  };

  // Close the dropdown before opening the dialog — two stacked Radix overlays
  // (menu + dialog) would otherwise fight over focus return on dismiss. The
  // dialog drives the full scaffold + open-in-new-window flow itself.
  const onCreateProject = () => {
    handleOpenChange(false);
    setCreateProjectOpen(true);
  };

  // Discovery → create shortcut: the flyout's "Create worktree …" no-match
  // option calls this with the typed query. Close the switcher (two stacked
  // Radix overlays fight focus return) and open the New Worktree dialog with the
  // branch name pre-filled — the user then picks the base branch and confirms.
  const openNewWorktreeWith = (name: string) => {
    handleOpenChange(false);
    setNewWorktreeInitialName(name);
    setNewWorktreeOpen(true);
  };

  // The current project stays IN the list (marked current, no-op on select) so
  // its linked worktrees are reachable from within it — worktrees are nested
  // under their repo, not filtered as "already open". Grouping + search live in
  // RecentProjectsMenu; `query` empty = grouped browse, non-empty = flat search.
  const currentPath = bridge.config.projectPath;
  const query = search.trim().toLowerCase();
  const isSearching = query !== '';
  // The top-level search matches PROJECTS ONLY — per-project worktrees/branches
  // are reachable via each row's side-flyout (and its own search). We gate the
  // DATA rather than editing RecentProjectsMenu's flat SearchResults: in search
  // mode, hand it recents with linked worktrees filtered out and no worktree
  // model, so it can only surface projects. In grouped browse mode the full
  // recents + model flow through unchanged (the flyouts still need them).
  // `recents` is null until the first fetch resolves — treat that as empty for
  // every downstream read (filter/map/length) so nothing NPEs mid-load.
  const loadedRecents = recents ?? [];
  const menuRecents = isSearching
    ? loadedRecents.filter((r) => !r.isLinkedWorktree)
    : loadedRecents;
  const menuWorktreeModel = isSearching ? null : worktreeModel;

  return (
    <>
      {/*
        Non-modal (matches the Cloud/Sync Popover, which is non-modal and works
        normally). In the macOS desktop app, outside-click dismissal relies on a
        `pointerdown` Chromium does not deliver here (see the trigger onClick),
        and a modal dropdown additionally disables pointer events on the
        rest of the chrome while open — together that left the menu impossible
        to dismiss by clicking out. Non-modal keeps the rest of the UI live and
        restores outside-click dismissal; the menu still closes on item-select,
        Escape, or re-clicking the trigger.
      */}
      <DropdownMenu open={open} onOpenChange={handleOpenChange} modal={false}>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            className={cn(
              'justify-between text-sidebar-foreground/70 hover:text-sidebar-foreground! data-open:hover:text-sidebar-foreground!',
              branch !== null && 'h-auto py-1.5',
            )}
            data-testid="project-switcher-trigger"
            aria-label={t`Open project menu`}
            title={bridge.config.projectPath}
            // In the macOS desktop app Chromium does not deliver real
            // `pointerdown` events to the renderer (only `mousedown`/`click`),
            // so Radix's pointerdown-driven open never fires and clicking the
            // trigger did nothing. The synthesized `click` still arrives, so on
            // the Electron host we drive open/close from it; the ref keeps it
            // from double-firing if a real pointerdown ever does arrive (Radix
            // would have handled the toggle then). Browsers keep Radix's
            // default. Mirrors the EditorHeader Open-with-AI trigger.
            onPointerDown={
              isElectronHost
                ? () => {
                    sawPointerDownRef.current = true;
                  }
                : undefined
            }
            onClick={
              isElectronHost
                ? () => {
                    if (sawPointerDownRef.current) {
                      sawPointerDownRef.current = false;
                      return;
                    }
                    handleOpenChange(!open);
                  }
                : undefined
            }
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate">{bridge.config.projectName}</span>
              {branch !== null ? (
                <span
                  className="flex min-w-0 items-center gap-1 text-xs text-sidebar-foreground/50 group-hover/menu-button:text-sidebar-foreground"
                  data-testid="project-switcher-branch"
                >
                  <GitBranch aria-hidden="true" className="size-3! shrink-0" />
                  <span className="truncate">{branch}</span>
                </span>
              ) : null}
            </span>
            <ChevronsUpDown aria-hidden="true" className="opacity-60" />
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="top"
          className="min-w-[260px]"
          data-testid="project-switcher-menu"
        >
          {/* Three states, not two: while `recents` is null the first fetch is
            still in flight — render nothing here (just the pinned footer actions
            below) rather than the empty label, so first open doesn't flash "No
            recent projects." before the list arrives. The label is only correct
            once loaded (`recents !== null`) AND empty. */}
          {recents === null ? null : recents.length === 0 ? (
            <DropdownMenuLabel className="font-normal text-muted-foreground text-xs">
              <Trans>No recent projects.</Trans>
            </DropdownMenuLabel>
          ) : (
            <>
              {/* stopPropagation on keydown so Radix's menu typeahead doesn't
                swallow keystrokes meant for the filter field. */}
              <InputGroup className="mb-1 h-8 border-0 shadow-none has-[[data-slot=input-group-control]:focus-visible]:ring-0">
                <InputGroupInput
                  aria-label={t`Search projects`}
                  placeholder={t`Search projects...`}
                  value={search}
                  onChange={(e) => {
                    // Query mode replaces the grouped rows with a flat search,
                    // so any open per-project flyout no longer has an anchor —
                    // close it as the user starts filtering.
                    if (e.target.value !== '') setFlyoutPath(null);
                    setSearch(e.target.value);
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                  data-testid="project-switcher-search"
                />
                <InputGroupAddon>
                  <Search aria-hidden="true" />
                </InputGroupAddon>
              </InputGroup>
              <DropdownMenuSeparator />
              {/* Only the items list scrolls — the search field above and the
                New / Switch / Open actions below stay pinned. Each group row's
                worktree Popover flyout portals out of this wrapper, so the
                scroll clip doesn't cut it off. overscroll-contain stops scroll
                chaining to the page behind the dropdown at the list edges. */}
              <div className="max-h-64 overflow-x-hidden overflow-y-auto overscroll-contain subtle-scrollbar scroll-fade-mask">
                <RecentProjectsMenu
                  bridge={bridge}
                  recents={menuRecents}
                  currentPath={currentPath}
                  query={query}
                  worktreeModel={menuWorktreeModel}
                  closeMenu={() => handleOpenChange(false)}
                  guardStaleSelect={guardStaleSelect}
                  flyoutPath={flyoutPath}
                  setFlyoutPath={setFlyoutPath}
                  openNewWorktreeWith={openNewWorktreeWith}
                />
              </div>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(e) => {
              if (guardStaleSelect(e)) return;
              onCreateProject();
            }}
            data-testid="project-switcher-new-project"
          >
            <Plus aria-hidden="true" className="text-muted-foreground" />
            <Trans>New project</Trans>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(e) => {
              if (guardStaleSelect(e)) return;
              onSwitchProject();
            }}
            data-testid="project-switcher-switch-project"
          >
            <LayoutGrid aria-hidden="true" className="text-muted-foreground" />
            <Trans>Switch project</Trans>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(e) => {
              if (guardStaleSelect(e)) return;
              onOpenFolder();
            }}
            data-testid="project-switcher-open-folder"
          >
            <FolderOpen aria-hidden="true" className="text-muted-foreground" />
            <Trans>Open folder</Trans>
          </DropdownMenuItem>
          {/* "New worktree" sits at the bottom of the project-selection menu:
            the per-project worktree flyouts are the primary worktree affordance
            now, so the standalone create action is a secondary, last-position
            entry. Gated on the current project being a git repo (a branch). */}
          {branch !== null ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={(e) => {
                  if (guardStaleSelect(e)) return;
                  handleOpenChange(false);
                  setNewWorktreeInitialName('');
                  setNewWorktreeOpen(true);
                }}
                data-testid="project-switcher-new-worktree"
              >
                <GitBranch aria-hidden="true" className="text-muted-foreground" />
                <Trans>New worktree</Trans>
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateProjectDialog
        open={createProjectOpen}
        onOpenChange={setCreateProjectOpen}
        bridge={bridge}
      />
      <NewWorktreeDialog
        open={newWorktreeOpen}
        onOpenChange={setNewWorktreeOpen}
        bridge={bridge}
        currentBranch={branch}
        initialBranchName={newWorktreeInitialName}
        branches={worktreeModel?.entries
          .map((entry) => entry.branch)
          .filter((b): b is string => b !== null)}
        // Branches that ALREADY have an open worktree (a non-null
        // `worktreePath`). The dialog uses this to distinguish "check out this
        // branch into a new worktree" from "this branch already has a worktree —
        // just open its window", since `worktree.create` on an already-checked-
        // out branch returns the existing path (`created: false`) and opens it.
        existingWorktreeBranches={
          new Set(
            worktreeModel?.entries
              .filter((entry) => entry.branch !== null && entry.worktreePath !== null)
              .map((entry) => entry.branch as string),
          )
        }
        // Remote-tracking refs (`origin/<x>`) drive both the remote-checkout
        // mode (a remote-only typed name) and the `--no-track` remote base
        // options.
        remoteBranches={worktreeModel?.remoteBranches}
        // Per-branch "behind origin" counts for the base selector's nudge hint.
        behindByBranch={
          new Map(
            worktreeModel?.entries
              .filter((entry) => entry.branch !== null && entry.behind !== undefined)
              .map((entry) => [entry.branch as string, entry.behind as number]),
          )
        }
      />
    </>
  );
}
