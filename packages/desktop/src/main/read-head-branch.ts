import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

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

export function parseGitHead(contents: string): HeadBranchInfo {
  const trimmed = contents.trim();
  if (trimmed.length === 0) return FAILURE;
  const refMatch = /^ref:\s+refs\/heads\/(.+)$/.exec(trimmed);
  if (refMatch) {
    const branch = refMatch[1].trim();
    if (branch.length === 0) return FAILURE;
    return { currentBranch: branch, headSha: null, detached: false };
  }
  const shaMatch = /^([0-9a-f]{40})$/.exec(trimmed);
  if (shaMatch) {
    return { currentBranch: null, headSha: shaMatch[1].slice(0, 7), detached: true };
  }
  return FAILURE;
}

function resolveGitDir(projectPath: string): string | null {
  const dotGit = join(projectPath, '.git');
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return dotGit;
  if (!stat.isFile()) return null;
  let pointer: string;
  try {
    pointer = readFileSync(dotGit, 'utf-8');
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(pointer.trim());
  if (!match) return null;
  const target = match[1].trim();
  const resolved = isAbsolute(target) ? target : resolve(projectPath, target);
  return existsSync(resolved) ? resolved : null;
}

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
  const gitDir = resolveGitDir(projectPath);
  if (gitDir === null) return FAILURE;
  const headPath = join(gitDir, 'HEAD');
  let contents: string;
  try {
    contents = readFileSync(headPath, 'utf-8');
  } catch {
    return FAILURE;
  }
  return parseGitHead(contents);
}
