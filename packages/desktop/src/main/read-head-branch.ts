/**
 * Lightweight `.git/HEAD` reader for the share-receive pre-server branch
 * check. Returns the symbolic ref's branch name (e.g. `feat/foo`), or the
 * short-SHA of a detached HEAD, or all-null on any failure mode (missing
 * `.git`, malformed HEAD, I/O error, traversal attempt).
 *
 * This runs before any project is opened — no server, no `simple-git`. The
 * receiver is choosing between silent dispatch (branches match) and falling
 * through to the branch-switch dialog (branches differ); a graceful fail
 * must collapse to silent dispatch so a single broken clone never blocks
 * a share-receive.
 */

import { isAbsolute, resolve } from 'node:path';
import { inspectGitRepository } from '@inkeep/open-knowledge-core/git-repository';

/**
 * Outcome of reading `<projectPath>/.git/HEAD`.
 *
 * - `currentBranch` is set when HEAD points at a symbolic ref
 *   (`ref: refs/heads/<name>`). Slashed branches (`feat/foo`) survive intact.
 * - `headSha` is the first 7 chars of the SHA when HEAD is detached. Caller
 *   uses it as a display label.
 * - `detached === true` distinguishes a detached HEAD (`{null, <sha>, true}`)
 *   from a graceful-fail (`{null, null, false}`).
 *
 * The all-null + `detached: false` shape is the "couldn't determine" sentinel
 * — caller falls back to silent dispatch.
 */
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

/**
 * Reject paths that aren't safe to read from a fresh IPC payload:
 * non-absolute paths, paths with NUL bytes, or paths whose resolved form
 * doesn't match the input (catches `..` escapes against the input's own
 * root). Absent-on-disk paths are not rejected here — the read flow
 * below treats them as graceful-fail naturally.
 */
function isSafeProjectPath(projectPath: string): boolean {
  if (typeof projectPath !== 'string') return false;
  if (projectPath.length === 0) return false;
  if (projectPath.includes('\0')) return false;
  if (!isAbsolute(projectPath)) return false;
  // `resolve` collapses `..` traversal; if the caller passed
  // `/a/b/../../etc`, `resolve` returns `/etc` and we refuse.
  if (resolve(projectPath) !== projectPath) return false;
  return true;
}

/**
 * Read `<projectPath>/.git/HEAD` and classify it. Never throws; any error
 * returns the all-null sentinel so the caller can fall back to silent
 * dispatch.
 */
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
