import { realpath as fsRealpath } from 'node:fs/promises';
import {
  type CandidateBridgeDeps,
  type CandidateSelection,
  type CandidateSelectionPayload,
  isGitWorkingTree,
  type RecentProjectEntry,
  selectCandidate,
} from '@inkeep/open-knowledge-core';
import { isProjectRoot } from '@inkeep/open-knowledge-server';
import { listGitWorktrees } from './list-git-worktrees.ts';
import { type ResolvedGitDirKind, readGitDirKind } from './read-git-dir-kind.ts';
import { readHeadBranch } from './read-head-branch.ts';

export interface MainShareTargetDeps {
  readonly listRecent: () => readonly RecentProjectEntry[];
}

export function filterShareEligibleRecents(
  recents: readonly RecentProjectEntry[],
): RecentProjectEntry[] {
  const dropped: ResolvedGitDirKind[] = [];
  const eligible = recents.filter((entry) => {
    const kind = readGitDirKind(entry.path);
    if (isGitWorkingTree(kind)) return true;
    dropped.push(kind);
    return false;
  });
  if (dropped.length > 0) {
    console.warn('[receive] recents_filtered reason=not_git_working_tree', {
      dropped: dropped.length,
      kinds: [...new Set(dropped)].sort(),
    });
  }
  return eligible;
}

function createMainCandidateBridge(deps: MainShareTargetDeps): CandidateBridgeDeps {
  return {
    listRecent: async () => filterShareEligibleRecents(deps.listRecent()),
    listGitWorktrees: (anchorPath) => listGitWorktrees(anchorPath),
    readHeadBranch: async (projectPath) => readHeadBranch(projectPath),
    readGitDirKind: async (projectPath) => readGitDirKind(projectPath),
    realpath: (path) => fsRealpath(path),
    isOkProjectRoot: async (projectPath) => {
      try {
        return isProjectRoot(projectPath);
      } catch (err) {
        console.warn('[receive] is_ok_project_root_failed; treating as non-OK', {
          code: (err as { code?: string }).code,
        });
        return false;
      }
    },
  };
}

export async function resolveShareTarget(
  payload: CandidateSelectionPayload,
  deps: MainShareTargetDeps,
): Promise<CandidateSelection> {
  return selectCandidate(payload, createMainCandidateBridge(deps));
}
