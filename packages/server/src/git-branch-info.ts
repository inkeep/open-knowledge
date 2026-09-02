import { isValidBranchName } from '@inkeep/open-knowledge-core';
import { truncateError } from './error-format.ts';
import { type DirtyOverlapResult, dirtyFilesOverlapWith } from './git-dirty.ts';
import { createGitInstance } from './git-handle.ts';
import { getLogger } from './logger.ts';

export { isValidBranchName };

export type BranchInfo =
  | {
      detached: false;
      currentBranch: string | null;
      currentHeadSha: null;
      shareTargetExists: boolean;
      dirtyConflicts: DirtyOverlapResult;
      branchIsLocal: boolean;
      shareTargetOnOriginBranch?: boolean;
    }
  | {
      detached: true;
      currentBranch: null;
      currentHeadSha: string;
      shareTargetExists: boolean;
      dirtyConflicts: DirtyOverlapResult;
      branchIsLocal: boolean;
      shareTargetOnOriginBranch?: boolean;
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
  const { git } = createGitInstance(projectDir, { credentialConfig: [] });

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

  const shareTargetOnOriginBranchPromise = (async (): Promise<boolean | undefined> => {
    const originRef = `origin/${targetBranch}`;
    const refPresent = await git
      .raw(['rev-parse', '--verify', originRef])
      .then(() => true)
      .catch(() => false);
    if (!refPresent) return undefined;
    if (kind === 'folder' && path === '') return true;
    return git
      .raw(['cat-file', '-e', `${originRef}:${path}`])
      .then(() => true)
      .catch(() => false);
  })();

  const dirtyPromise = dirtyFilesOverlapWith(projectDir, targetBranch).catch(
    (err: unknown): DirtyOverlapResult => {
      if (isBranchResolutionError(err)) return { conflicts: false, files: [] };
      getLogger('git-branch-info').warn(
        { branch: targetBranch, err },
        `action=dirty-overlap-failed branch=${targetBranch} error=${truncateError(err)}`,
      );
      return { conflicts: false, files: [] };
    },
  );

  const [headState, shareTargetExists, branchIsLocal, dirtyConflicts, shareTargetOnOriginBranch] =
    await Promise.all([
      headStatePromise,
      shareTargetPromise,
      branchIsLocalPromise,
      dirtyPromise,
      shareTargetOnOriginBranchPromise,
    ]);

  if (headState.detached) {
    return {
      detached: true,
      currentBranch: null,
      currentHeadSha: headState.currentHeadSha,
      shareTargetExists,
      dirtyConflicts,
      branchIsLocal,
      shareTargetOnOriginBranch,
    };
  }
  return {
    detached: false,
    currentBranch: headState.currentBranch,
    currentHeadSha: null,
    shareTargetExists,
    dirtyConflicts,
    branchIsLocal,
    shareTargetOnOriginBranch,
  };
}

export const BRANCH_INFO_HANDLER_TAG = 'git-branch-info';

export function isBranchResolutionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unknown revision|bad revision|ambiguous argument/i.test(message);
}
