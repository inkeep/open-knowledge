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
 *
 * Parse semantics mirror `readGitHeadBranch` in
 * `packages/server/src/share/git-context.ts`. Re-implemented here (rather
 * than imported) because desktop main does not depend on server.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

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
 * Parse a `.git/HEAD` contents blob. Pure — separated so the regex semantics
 * are unit-testable without filesystem fixtures.
 *
 * Accepted inputs:
 * - `ref: refs/heads/<branch>\n?` → `{currentBranch, null, false}`
 *   Branch names may contain `/` (e.g. `feat/foo`); the regex captures
 *   everything after `refs/heads/`.
 * - 40-char lowercase hex SHA → `{null, <short7>, true}`
 *
 * Anything else (empty, malformed, partial SHA, mixed-case) collapses to the
 * graceful-fail sentinel.
 */
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

/**
 * Resolve the absolute `.git` directory for a project. Handles both the
 * common directory layout and worktrees (where `.git` is a file containing
 * `gitdir: <path>`). Mirrors the helpers in `git-remote.ts` and
 * `git-context.ts`. Returns `null` on any I/O or parse failure.
 */
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
