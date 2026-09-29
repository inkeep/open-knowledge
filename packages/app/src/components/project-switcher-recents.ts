import type {
  WorktreeInventoryEntry,
  WorktreeInventoryLocation,
  WorktreeInventoryModel,
  WorktreeInventoryOpenRequest,
  WorktreeSelectorModel,
} from '@inkeep/open-knowledge-core';
import type { RecentProjectEntry } from '@/lib/desktop-bridge-types';

export interface RecentRepoGroup {
  readonly key: string;
  readonly project: RecentProjectEntry;
  readonly primaryProject: RecentProjectEntry | null;
  readonly worktrees: readonly RecentProjectEntry[];
  readonly recentEntries: readonly RecentProjectEntry[];
  readonly projectSynthesized: boolean;
  readonly repositoryName: string;
  readonly gitCommonDir: string | null;
  readonly projectSubPath: string | null;
  readonly inventoryAnchorPath: string | null;
}

interface WorktreeCheckoutFlyoutEntry {
  readonly kind: 'checkout';
  readonly branch: string | null;
  readonly headSha: string | null;
  readonly path: string;
  readonly checkoutRoot: string;
  readonly location: WorktreeInventoryLocation | 'unknown';
  readonly availability: 'available' | 'missing' | 'unreadable';
  readonly locked: boolean;
  readonly prunable: boolean;
  readonly isCurrent: boolean;
  readonly inventoryOpenRequest: WorktreeInventoryOpenRequest | null;
}

interface WorktreeBranchFlyoutEntry {
  readonly kind: 'branch';
  readonly branch: string;
  readonly headSha: null;
  readonly path: null;
  readonly checkoutRoot: null;
  readonly location: 'none';
  readonly availability: 'available';
  readonly locked: false;
  readonly prunable: false;
  readonly isCurrent: false;
  readonly inventoryOpenRequest: null;
}

export type WorktreeFlyoutEntry = WorktreeCheckoutFlyoutEntry | WorktreeBranchFlyoutEntry;

export type RowLocation = WorktreeInventoryLocation | 'unknown' | 'none';

export function rowLocation(entry: WorktreeFlyoutEntry): RowLocation {
  return entry.location;
}

export function buildWorktreeFlyoutEntries(
  group: RecentRepoGroup,
  inventory: WorktreeInventoryModel | null,
  worktreeModel: WorktreeSelectorModel | null,
  currentPath: string,
): WorktreeFlyoutEntry[] {
  const entries: WorktreeFlyoutEntry[] = [];
  const seenPaths = new Set<string>();
  const seenBranches = new Set<string>();
  const recentRank = new Map(
    [...group.recentEntries]
      .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))
      .map((entry, index) => [entry.path, index]),
  );

  if (inventoryMatchesGroup(inventory, group)) {
    for (const entry of inventory.entries) {
      entries.push(inventoryFlyoutEntry(entry, inventory, group, currentPath));
      seenPaths.add(entry.projectPath);
      if (entry.branch !== null) seenBranches.add(entry.branch);
    }
  }

  for (const recent of group.recentEntries) {
    if (seenPaths.has(recent.path)) continue;
    const isPrimary = recent.isLinkedWorktree !== true;
    entries.push({
      kind: 'checkout',
      branch: recent.branch ?? null,
      headSha: null,
      path: recent.path,
      checkoutRoot: recent.checkoutRoot ?? recent.path,
      location: isPrimary ? 'primary' : 'unknown',
      availability: recent.missing === true ? 'missing' : 'available',
      locked: false,
      prunable: false,
      isCurrent: recent.path === currentPath,
      inventoryOpenRequest: null,
    });
    seenPaths.add(recent.path);
    if (recent.branch != null) seenBranches.add(recent.branch);
  }

  if (group.recentEntries.some((entry) => entry.path === currentPath)) {
    for (const selectorEntry of worktreeModel?.entries ?? []) {
      if (
        selectorEntry.branch === null ||
        selectorEntry.worktreePath !== null ||
        seenBranches.has(selectorEntry.branch)
      ) {
        continue;
      }
      entries.push({
        kind: 'branch',
        branch: selectorEntry.branch,
        headSha: null,
        path: null,
        checkoutRoot: null,
        location: 'none',
        availability: 'available',
        locked: false,
        prunable: false,
        isCurrent: false,
        inventoryOpenRequest: null,
      });
      seenBranches.add(selectorEntry.branch);
    }
  }

  return entries.sort((a, b) => compareFlyout(a, b, recentRank));
}

function inventoryFlyoutEntry(
  entry: WorktreeInventoryEntry,
  inventory: WorktreeInventoryModel,
  group: RecentRepoGroup,
  currentPath: string,
): WorktreeCheckoutFlyoutEntry {
  return {
    kind: 'checkout',
    branch: entry.branch,
    headSha: entry.headSha,
    path: entry.projectPath,
    checkoutRoot: entry.checkoutRoot,
    location: entry.location,
    availability: entry.availability,
    locked: entry.locked,
    prunable: entry.prunable,
    isCurrent: entry.projectPath === currentPath,
    inventoryOpenRequest:
      group.inventoryAnchorPath === null
        ? null
        : {
            anchorProjectPath: group.inventoryAnchorPath,
            gitCommonDir: inventory.gitCommonDir,
            projectSubPath: inventory.projectSubPath,
            checkoutRoot: entry.checkoutRoot,
            projectPath: entry.projectPath,
          },
  };
}

function compareFlyout(
  a: WorktreeFlyoutEntry,
  b: WorktreeFlyoutEntry,
  recentRank: ReadonlyMap<string, number>,
): number {
  const rank = (entry: WorktreeFlyoutEntry): readonly [number, number, string] => {
    if (entry.kind === 'checkout' && entry.location === 'primary') return [0, 0, entry.path];
    if (entry.kind === 'checkout') {
      const recent = recentRank.get(entry.path);
      return [recent === undefined ? 2 : 1, recent ?? 0, entry.branch ?? entry.path];
    }
    return [3, 0, entry.branch];
  };
  const ar = rank(a);
  const br = rank(b);
  return ar[0] - br[0] || ar[1] - br[1] || ar[2].localeCompare(br[2]);
}

function inventoryMatchesGroup(
  inventory: WorktreeInventoryModel | null,
  group: RecentRepoGroup,
): inventory is WorktreeInventoryModel {
  return (
    inventory !== null &&
    inventory.gitCommonDir === group.gitCommonDir &&
    inventory.projectSubPath === group.projectSubPath
  );
}

export function basenameOf(path: string): string {
  const segments = path.split(/[/\\]/).filter((segment) => segment.length > 0);
  return segments.length > 0 ? (segments[segments.length - 1] ?? path) : path;
}

interface GroupBuilder {
  readonly key: string;
  readonly gitCommonDir: string;
  readonly mainRoot: string;
  readonly projectSubPath: string;
  readonly recentEntries: RecentProjectEntry[];
}

export function groupRecentsByRepo(recents: readonly RecentProjectEntry[]): RecentRepoGroup[] {
  const order: Array<RecentRepoGroup | GroupBuilder> = [];
  const builders = new Map<string, GroupBuilder>();

  for (const entry of recents) {
    if (
      entry.gitCommonDir === undefined ||
      entry.mainRoot === undefined ||
      entry.projectSubPath === undefined
    ) {
      order.push(singleProjectGroup(entry));
      continue;
    }
    const key = `${entry.gitCommonDir}\0${entry.projectSubPath}`;
    let builder = builders.get(key);
    if (builder === undefined) {
      builder = {
        key,
        gitCommonDir: entry.gitCommonDir,
        mainRoot: entry.mainRoot,
        projectSubPath: entry.projectSubPath,
        recentEntries: [],
      };
      builders.set(key, builder);
      order.push(builder);
    }
    builder.recentEntries.push(entry);
  }

  return order.map((item) => ('mainRoot' in item ? finalizeGitGroup(item) : item));
}

function finalizeGitGroup(builder: GroupBuilder): RecentRepoGroup {
  const ordered = [...builder.recentEntries].sort((a, b) =>
    b.lastOpenedAt.localeCompare(a.lastOpenedAt),
  );
  const primaryProject = ordered.find((entry) => entry.isLinkedWorktree !== true) ?? null;
  const project = primaryProject ?? ordered[0];
  if (project === undefined) throw new Error('Git-backed recent group has no entries');
  return {
    key: builder.key,
    project,
    primaryProject,
    worktrees: ordered.filter((entry) => entry.isLinkedWorktree === true),
    recentEntries: ordered,
    projectSynthesized: primaryProject === null,
    repositoryName: basenameOf(builder.mainRoot),
    gitCommonDir: builder.gitCommonDir,
    projectSubPath: builder.projectSubPath,
    inventoryAnchorPath: ordered.find((entry) => entry.missing !== true)?.path ?? null,
  };
}

function singleProjectGroup(project: RecentProjectEntry): RecentRepoGroup {
  return {
    key: `project:${project.path}`,
    project,
    primaryProject: project,
    worktrees: [],
    recentEntries: [project],
    projectSynthesized: false,
    repositoryName: project.name,
    gitCommonDir: null,
    projectSubPath: null,
    inventoryAnchorPath: null,
  };
}
