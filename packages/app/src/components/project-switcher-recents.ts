import type { WorktreeSelectorModel } from '@inkeep/open-knowledge-core';
import type { RecentProjectEntry } from '@/lib/desktop-bridge-types';

export interface RecentRepoGroup {
  readonly project: RecentProjectEntry;
  readonly worktrees: readonly RecentProjectEntry[];
  readonly projectSynthesized: boolean;
}

export interface WorktreeFlyoutEntry {
  readonly branch: string | null;
  readonly path: string | null;
  readonly opened: boolean;
  readonly isMain: boolean;
  readonly isCurrent: boolean;
}

export type RowLocation = 'primary' | 'worktree' | 'none';

export function rowLocation(entry: Pick<WorktreeFlyoutEntry, 'isMain' | 'opened'>): RowLocation {
  if (!entry.opened) return 'none';
  return entry.isMain ? 'primary' : 'worktree';
}

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

  return entries.sort((a, b) => rankFlyout(a) - rankFlyout(b));
}

function rankFlyout(e: WorktreeFlyoutEntry): number {
  if (e.isMain) return 0;
  if (e.opened) return 1;
  return 2;
}

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
