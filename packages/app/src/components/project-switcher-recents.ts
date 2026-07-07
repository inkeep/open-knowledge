/**
 * Pure grouping of enriched recent projects into repo groups so the
 * ProjectSwitcher can nest linked worktrees under their main project. Git recents are grouped by `gitCommonDir`;
 * within a group the main worktree is the project row and linked worktrees nest
 * under it. When only a worktree of a repo is in recents (the main was never
 * opened), the project row is synthesized from `mainRoot` so the worktree still
 * nests somewhere. Non-git recents are singleton groups (no worktrees).
 *
 * Order is preserved from the LRU recents list: a group takes the position of
 * its first-seen member; worktrees within a group keep their recency order.
 */

import type { WorktreeSelectorModel } from '@inkeep/open-knowledge-core';
import type { RecentProjectEntry } from '@/lib/desktop-bridge-types';

export interface RecentRepoGroup {
  /** The main project row (synthesized from `mainRoot` when not itself a recent). */
  readonly project: RecentProjectEntry;
  /** Opened linked worktrees of this repo (excludes the main). */
  readonly worktrees: readonly RecentProjectEntry[];
  /** True when `project` was synthesized (its main root wasn't in recents). */
  readonly projectSynthesized: boolean;
}

/**
 * A single row in a project's worktree flyout — either a worktree/branch that
 * already has a window (`open`, `path` set), or a local branch of the CURRENT
 * project with no worktree yet (`create-on-demand`, `path` null). The flyout
 * merges opened worktrees from Recents with the current project's cached branch
 * list, so typing a branch name that has never been opened still reaches it.
 */
export interface WorktreeFlyoutEntry {
  /** Branch name, or `null` for a detached-HEAD worktree. */
  readonly branch: string | null;
  /** Worktree path when a window exists; `null` for a create-on-demand branch. */
  readonly path: string | null;
  /** `true` = a checked-out worktree to open; `false` = create its worktree first. */
  readonly opened: boolean;
  /** The repo's main (primary) worktree — pinned to the top of the flyout. */
  readonly isMain: boolean;
  /** This entry's worktree is the currently-focused window's project. */
  readonly isCurrent: boolean;
}

/**
 * Ordered rows for a project's worktree side-flyout. The main worktree is pinned
 * to the top; opened worktrees follow by recency (most-recently-opened first,
 * using the Recents `lastOpenedAt`); create-on-demand branches (no worktree yet)
 * come last, alphabetized. Only the CURRENT project has a cached branch model,
 * so un-opened branches only appear for it — other projects show just their
 * opened worktrees (main + linked).
 *
 * `worktreeModel` is the cached model for the current window's project and is
 * only merged in when this group IS the current project (its `mainRoot` matches
 * the model's `mainRoot`). Passing it for a non-current group is a no-op.
 */
export function buildWorktreeFlyoutEntries(
  group: RecentRepoGroup,
  worktreeModel: WorktreeSelectorModel | null,
  currentPath: string,
): WorktreeFlyoutEntry[] {
  const entries: WorktreeFlyoutEntry[] = [];
  const seenPaths = new Set<string>();
  const seenBranches = new Set<string>();

  const isCurrentModel =
    worktreeModel !== null && worktreeModel.mainRoot === group.project.mainRoot;

  // The main worktree is the project row's own checkout — represent it in the
  // flyout so opening the default branch is a first-class, pinned choice. A
  // synthesized project row (never opened) has no real path to open.
  if (!group.projectSynthesized) {
    entries.push({
      branch: group.project.branch ?? null,
      path: group.project.path,
      opened: true,
      isMain: true,
      isCurrent: group.project.path === currentPath,
    });
    seenPaths.add(group.project.path);
    if (group.project.branch != null) seenBranches.add(group.project.branch);
  }

  // Opened linked worktrees from Recents, most-recently-opened first.
  const openedByRecency = [...group.worktrees].sort((a, b) =>
    b.lastOpenedAt.localeCompare(a.lastOpenedAt),
  );
  for (const wt of openedByRecency) {
    if (seenPaths.has(wt.path)) continue;
    entries.push({
      branch: wt.branch ?? null,
      path: wt.path,
      opened: true,
      isMain: false,
      isCurrent: wt.path === currentPath,
    });
    seenPaths.add(wt.path);
    if (wt.branch != null) seenBranches.add(wt.branch);
  }

  // Create-on-demand branches: only the current project has a cached branch
  // model. Skip branches already represented by an opened worktree above.
  if (isCurrentModel) {
    const modelExtras = worktreeModel.entries
      .filter(
        (e) =>
          e.branch !== null &&
          !seenBranches.has(e.branch) &&
          (e.worktreePath === null || !seenPaths.has(e.worktreePath)),
      )
      .sort((a, b) => (a.branch ?? '').localeCompare(b.branch ?? ''));
    for (const e of modelExtras) {
      // A branch whose worktree exists but wasn't in Recents (opened elsewhere)
      // still counts as opened; a null worktreePath is create-on-demand.
      entries.push({
        branch: e.branch,
        path: e.worktreePath,
        opened: e.worktreePath !== null,
        isMain: e.isMain,
        isCurrent: e.isCurrent,
      });
      if (e.branch != null) seenBranches.add(e.branch);
      if (e.worktreePath != null) seenPaths.add(e.worktreePath);
    }
  }

  // Pin main to the very top, opened worktrees next, create-on-demand last.
  // Stable within each tier (the source arrays are already ordered per tier).
  return entries.sort((a, b) => rankFlyout(a) - rankFlyout(b));
}

function rankFlyout(e: WorktreeFlyoutEntry): number {
  if (e.isMain) return 0;
  if (e.opened) return 1;
  return 2;
}

/** Trailing path segment, tolerant of `/` and `\` (no `node:path` in the renderer). */
export function basenameOf(path: string): string {
  const segments = path.split(/[/\\]/).filter((s) => s.length > 0);
  return segments.length > 0 ? (segments[segments.length - 1] ?? path) : path;
}

interface GroupBuilder {
  project: RecentProjectEntry | null;
  mainRoot: string;
  worktrees: RecentProjectEntry[];
}

export function groupRecentsByRepo(recents: readonly RecentProjectEntry[]): RecentRepoGroup[] {
  const builders: GroupBuilder[] = [];
  const gitGroupIndex = new Map<string, number>();

  for (const entry of recents) {
    const commonDir = entry.gitCommonDir;
    const mainRoot = entry.mainRoot;
    if (commonDir === undefined || mainRoot === undefined) {
      // Non-git (or un-enriched) → its own singleton group.
      builders.push({ project: entry, mainRoot: entry.path, worktrees: [] });
      continue;
    }
    let idx = gitGroupIndex.get(commonDir);
    if (idx === undefined) {
      idx = builders.length;
      gitGroupIndex.set(commonDir, idx);
      builders.push({ project: null, mainRoot, worktrees: [] });
    }
    const builder = builders[idx];
    if (builder === undefined) continue;
    if (entry.isLinkedWorktree) builder.worktrees.push(entry);
    else if (builder.project === null) builder.project = entry;
  }

  return builders.map((builder) => {
    const synthesized = builder.project === null;
    const project = builder.project ?? {
      path: builder.mainRoot,
      name: basenameOf(builder.mainRoot),
      lastOpenedAt: '',
    };
    return { project, worktrees: builder.worktrees, projectSynthesized: synthesized };
  });
}
