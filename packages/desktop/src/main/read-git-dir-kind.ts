/**
 * Renderer-callable wrapper around `resolveGitDirDetailed` from core. Returns
 * just the discriminator string (`'directory'` / `'linked'` / `'absent'` /
 * `'malformed-pointer'` / `'inaccessible'`) so the IPC payload stays small
 * and JSON-stable across the wire.
 *
 * Used by the share-receive Q1 candidate-selection step to partition
 * Candidates into "main checkouts" (`'directory'`) vs "linked worktrees"
 * (`'linked'`) for the no-branch-match fallback — selection prefers main
 * checkouts over worktrees because switching main is safe; switching a
 * worktree off its branch defeats the worktree's purpose.
 *
 * Never throws — every input-rejection or filesystem error collapses to
 * `'absent'` so the caller treats the candidate as a no-`.git`-here
 * fall-through. The pure `resolveGitDirDetailed` already returns
 * `'malformed-pointer'` and `'inaccessible'` as discriminated values, so the
 * caller can distinguish them when useful; selection treats all three
 * non-`'directory'`/`'linked'` values identically (skip the candidate in
 * fallback partitioning).
 */

import { isAbsolute } from 'node:path';
import { resolveGitDirDetailed } from '@inkeep/open-knowledge-core/shadow-repo-layout';

/**
 * Discriminator-only projection of `ResolvedGitDir.kind`. Mirrors the source
 * union exactly so future additions surface as a TypeScript exhaustiveness
 * check on every caller.
 */
export type ResolvedGitDirKind =
  | 'directory'
  | 'linked'
  | 'absent'
  | 'malformed-pointer'
  | 'inaccessible';

export function readGitDirKind(projectPath: string): ResolvedGitDirKind {
  if (!isAbsolute(projectPath)) return 'absent';
  try {
    return resolveGitDirDetailed(projectPath).kind;
  } catch {
    return 'absent';
  }
}
