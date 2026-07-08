/**
 * Lenient dirty-tree detection for branch-switch and git-sync pre-checks.
 *
 * `dirtyFilesOverlapWith` returns the intersection of the working-tree's dirty
 * file set and the set of files that would change when moving from the current
 * ref to `targetRef`. It mirrors git's own behaviour: only files that would be
 * overwritten by the switch block the operation. Untracked files at overlapping
 * paths count as conflicts because `git checkout` refuses to silently overwrite
 * them.
 */

import { createGitInstance } from './git-handle.ts';
import { listNames, listPorcelainPaths } from './git-paths.ts';

export interface DirtyOverlapResult {
  conflicts: boolean;
  files: string[];
}

/**
 * Returns the intersection of dirty working-tree files and files changed by
 * switching from the current ref to `targetRef`.
 *
 * - `{conflicts: false, files: []}` when either set is empty or the sets are
 *   disjoint.
 * - `{conflicts: true, files: [...]}` when at least one path appears in both
 *   sets. `files` is sorted ascending and deduped.
 *
 * Throws if `targetRef` cannot be resolved by git (matches simple-git's error
 * propagation). Callers receive the original simple-git error so they can
 * surface a meaningful reason to the user.
 *
 * Read-only; does not acquire `withParentLock`.
 */
export async function dirtyFilesOverlapWith(
  cwd: string,
  targetRef: string,
): Promise<DirtyOverlapResult> {
  const { git } = createGitInstance(cwd);

  const [dirtyList, changed] = await Promise.all([
    listPorcelainPaths(git),
    // Two-dot diff — all files differing between HEAD and targetRef, in either
    // direction. Three-dot (`HEAD...targetRef`) resolves to merge-base..targetRef
    // and misses files HEAD changed since divergence, which `git checkout` would
    // still restore to the target's view.
    listNames(git, ['diff', '--name-only', `HEAD..${targetRef}`]),
  ]);

  const dirty = new Set(dirtyList);
  if (dirty.size === 0) return { conflicts: false, files: [] };

  if (changed.length === 0) return { conflicts: false, files: [] };

  const overlap = new Set<string>();
  for (const path of changed) {
    if (dirty.has(path)) overlap.add(path);
  }

  if (overlap.size === 0) return { conflicts: false, files: [] };
  return { conflicts: true, files: Array.from(overlap).sort() };
}
