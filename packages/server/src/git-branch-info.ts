import { isValidBranchName } from '@inkeep/open-knowledge-core';
import { type DirtyOverlapResult, dirtyFilesOverlapWith } from './git-dirty.ts';
import { createGitInstance } from './git-handle.ts';

export { isValidBranchName };

export type BranchInfo =
  | {
      detached: false;
      currentBranch: string | null;
      currentHeadSha: null;
      shareTargetExists: boolean;
      dirtyConflicts: DirtyOverlapResult;
      branchIsLocal: boolean;
    }
  | {
      detached: true;
      currentBranch: null;
      currentHeadSha: string;
      shareTargetExists: boolean;
      dirtyConflicts: DirtyOverlapResult;
      branchIsLocal: boolean;
    };

export function isValidBranchInfoPath(path: unknown, kind: 'doc' | 'folder'): path is string {
  if (typeof path !== 'string') return false;
  if (path.length === 0) return kind === 'folder';
  if (path.startsWith('/')) return false;
  if (path.includes('\\')) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control chars are exactly what we want to reject
  if (/[\x00-\x1F\x7F]/.test(path)) return false;
  for (const segment of path.split('/')) {
    if (segment.length === 0) return false;
    if (segment === '..' || segment === '.git') return false;
  }
  return true;
}

export async function computeBranchInfo(
  projectDir: string,
  targetBranch: string,
  path: string,
  kind: 'doc' | 'folder',
): Promise<BranchInfo> {
  const { git } = createGitInstance(projectDir);

  await git.raw(['rev-parse', '--git-dir']);

  const headStatePromise = (async (): Promise<
    | { detached: false; currentBranch: string | null; currentHeadSha: null }
    | { detached: true; currentBranch: null; currentHeadSha: string }
  > => {
    try {
      const ref = (await git.raw(['symbolic-ref', 'HEAD'])).trim();
      const match = /^refs\/heads\/(.+)$/.exec(ref);
      const branch = match ? match[1] : null;
      return { detached: false, currentBranch: branch, currentHeadSha: null };
    } catch {
      const sha = (await git.raw(['rev-parse', '--short=7', 'HEAD'])).trim();
      if (sha.length === 0) {
        return { detached: false, currentBranch: null, currentHeadSha: null };
      }
      return { detached: true, currentBranch: null, currentHeadSha: sha };
    }
  })();

  const shareTargetPromise = headStatePromise.then(async (head) => {
    if (kind === 'folder' && path === '') return true;
    const ref = head.detached ? 'HEAD' : head.currentBranch;
    if (!ref) return false;
    try {
      await git.raw(['cat-file', '-e', `${ref}:${path}`]);
      return true;
    } catch {
      return false;
    }
  });

  const branchIsLocalPromise = git
    .raw(['rev-parse', '--verify', `refs/heads/${targetBranch}`])
    .then(() => true)
    .catch(() => false);

  const dirtyPromise = dirtyFilesOverlapWith(projectDir, targetBranch).catch(
    (err: unknown): DirtyOverlapResult => {
      if (isBranchResolutionError(err)) return { conflicts: false, files: [] };
      const message = err instanceof Error ? err.message : String(err);
      const truncated = message.length > 500 ? `${message.slice(0, 500)}…` : message;
      console.warn(
        `[git-branch-info] action=dirty-overlap-failed branch=${targetBranch} error=${truncated}`,
      );
      return { conflicts: false, files: [] };
    },
  );

  const [headState, shareTargetExists, branchIsLocal, dirtyConflicts] = await Promise.all([
    headStatePromise,
    shareTargetPromise,
    branchIsLocalPromise,
    dirtyPromise,
  ]);

  if (headState.detached) {
    return {
      detached: true,
      currentBranch: null,
      currentHeadSha: headState.currentHeadSha,
      shareTargetExists,
      dirtyConflicts,
      branchIsLocal,
    };
  }
  return {
    detached: false,
    currentBranch: headState.currentBranch,
    currentHeadSha: null,
    shareTargetExists,
    dirtyConflicts,
    branchIsLocal,
  };
}

export const BRANCH_INFO_HANDLER_TAG = 'git-branch-info';

export function isBranchResolutionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unknown revision|bad revision|ambiguous argument/i.test(message);
}
