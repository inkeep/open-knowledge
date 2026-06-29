import { realpath as fsRealpath } from 'node:fs/promises';
import {
  type CandidateBridgeDeps,
  type CandidateSelection,
  type CandidateSelectionPayload,
  type RecentProjectEntry,
  selectCandidate,
} from '@inkeep/open-knowledge-core';
import { isProjectRoot } from '@inkeep/open-knowledge-server';
import { listGitWorktrees } from './list-git-worktrees.ts';
import { readGitDirKind } from './read-git-dir-kind.ts';
import { readHeadBranch } from './read-head-branch.ts';

export interface MainShareTargetDeps {
  readonly listRecent: () => readonly RecentProjectEntry[];
}

function createMainCandidateBridge(deps: MainShareTargetDeps): CandidateBridgeDeps {
  return {
    listRecent: async () => deps.listRecent(),
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
