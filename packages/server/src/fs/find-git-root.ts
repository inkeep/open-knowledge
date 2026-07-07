/**
 * Upward-walk helper that finds the nearest enclosing git working tree.
 *
 * Uses `existsSync(<cur>/.git)` with no `.isDirectory()` check on purpose:
 * inside a linked worktree created by `git worktree add`, the per-worktree
 * `.git` is a regular file containing `gitdir: <path>`, not a directory.
 * Filtering to directories silently skips every worktree-rooted project.
 *
 * Walks use `path.resolve` only; they intentionally do NOT call
 * `fs.realpath`. The user's mental model is the path they picked, not the
 * inode it resolves to. See the sibling `find-project-root.ts` for the
 * rationale.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Maximum ancestor levels traversed before giving up. Matches the cap in
 * `findEnclosingProjectRoot` and `folder-admission.ts`.
 */
const ANCESTOR_WALK_DEPTH_LIMIT = 30;

const GIT_MARKER = '.git';

export interface FindEnclosingGitRootResult {
  readonly gitRoot: string;
  readonly distance: number;
}

/**
 * Walk upward from `dir` looking for an ancestor whose `<cur>/.git` exists
 * (as either a directory or a regular file — the worktree case). Returns
 * the first hit with the directory distance from the input
 * (0 = `dir` itself is a git root); returns `null` if no ancestor up to
 * filesystem root carries a `.git` entry.
 */
export function findEnclosingGitRoot(dir: string): FindEnclosingGitRootResult | null {
  let cursor = resolve(dir);
  let distance = 0;
  while (distance < ANCESTOR_WALK_DEPTH_LIMIT) {
    let hit = false;
    try {
      hit = existsSync(resolve(cursor, GIT_MARKER));
    } catch {
      hit = false;
    }
    if (hit) {
      return { gitRoot: cursor, distance };
    }
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
    distance += 1;
  }
  return null;
}
