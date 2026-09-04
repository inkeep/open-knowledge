import { isAbsolute, resolve } from 'node:path';
import { inspectGitRepository } from '@inkeep/open-knowledge-core/git-repository';

export interface HeadBranchInfo {
  readonly currentBranch: string | null;
  readonly headSha: string | null;
  readonly detached: boolean;
}

const FAILURE: HeadBranchInfo = {
  currentBranch: null,
  headSha: null,
  detached: false,
};

function isSafeProjectPath(projectPath: string): boolean {
  if (typeof projectPath !== 'string') return false;
  if (projectPath.length === 0) return false;
  if (projectPath.includes('\0')) return false;
  if (!isAbsolute(projectPath)) return false;
  if (resolve(projectPath) !== projectPath) return false;
  return true;
}

export function readHeadBranch(projectPath: string): HeadBranchInfo {
  if (!isSafeProjectPath(projectPath)) return FAILURE;
  const inspection = inspectGitRepository(projectPath);
  if (inspection.kind !== 'repository') return FAILURE;

  const head = inspection.repository.readHead();
  if (head.kind === 'branch') {
    return { currentBranch: head.branch, headSha: null, detached: false };
  }
  if (head.kind === 'detached') {
    return { currentBranch: null, headSha: head.oid.slice(0, 7), detached: true };
  }
  return FAILURE;
}
