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

import { createGitInstance, splitNulSeparatedPaths } from './git-handle.ts';

export interface DirtyOverlapResult {
  conflicts: boolean;
  files: string[];
}

function parsePorcelainPaths(porcelain: string): string[] {
  // -z porcelain: NUL-separated "XY PATH" records; a rename/copy emits the
  // original path as the following record, without a status prefix.
  const paths: string[] = [];
  const records = porcelain.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? '';
    if (record.length < 4) continue;
    paths.push(record.slice(3));
    if (record[0] === 'R' || record[0] === 'C') i++;
  }
  return paths;
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

  const [porcelain, diff] = await Promise.all([
    git.raw(['status', '--porcelain', '-z']),
    // Two-dot diff — all files differing between HEAD and targetRef, in either
    // direction. Three-dot (`HEAD...targetRef`) resolves to merge-base..targetRef
    // and misses files HEAD changed since divergence, which `git checkout` would
    // still restore to the target's view.
    git.raw(['diff', '--name-only', '-z', `HEAD..${targetRef}`]),
  ]);

  const dirty = new Set(parsePorcelainPaths(porcelain));
  if (dirty.size === 0) return { conflicts: false, files: [] };

  const changed = splitNulSeparatedPaths(diff);
  if (changed.length === 0) return { conflicts: false, files: [] };

  const overlap = new Set<string>();
  for (const path of changed) {
    if (dirty.has(path)) overlap.add(path);
  }

  if (overlap.size === 0) return { conflicts: false, files: [] };
  return { conflicts: true, files: Array.from(overlap).sort() };
}
