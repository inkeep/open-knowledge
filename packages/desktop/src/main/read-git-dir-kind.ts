/**
 * Classify `<projectPath>/.git` — is a branch checked out at THIS exact path?
 * Returns just the discriminator string (`'directory'` / `'linked'` /
 * `'absent'` / `'malformed-pointer'` / `'inaccessible'`).
 *
 * Used by the share-receive candidate-selection step, both to admit share
 * candidates at all and to partition them into "main checkouts"
 * (`'directory'`) vs "linked worktrees" (`'linked'`) for the no-branch-match
 * fallback — selection prefers main checkouts over worktrees because
 * switching main is safe; switching a worktree off its branch defeats the
 * worktree's purpose.
 *
 * `resolveGitDirDetailed` answers a DIFFERENT question — "which gitdir hosts
 * this path's shadow repo?" — whose correct answer for a subfolder is the
 * ancestor's gitdir, and which never verifies the `.git` it found is a real
 * working tree. Three real on-disk states diverge, so each is narrowed here:
 *
 *   - `.git` found at an ANCESTOR (non-empty `projectSubPath`): no branch is
 *     checked out at this path. Same `projectSubPath === ''` idiom as
 *     `folder-admission.ts`'s linked-worktree carveout.
 *   - `.git` pointer whose admin gitdir is gone: a stale worktree pointer.
 *     `resolveShadowDir` already classifies this state as
 *     `MalformedGitPointerError`.
 *   - `.git/` directory with no `HEAD`: a shell `.git/` holding only a shadow
 *     repo. `resolveShadowDir`'s no-`.git` fallthrough returns
 *     `<projectRoot>/.git/ok` and `initShadowRepo` mkdir -p's it, so OK itself
 *     creates this shape whenever a server boots against a path with no repo.
 *
 * Never throws: an input rejection or an unresolvable `.git` yields `'absent'`;
 * a `.git` that exists but can't be read yields `'inaccessible'`. Callers can
 * distinguish `'malformed-pointer'` and `'inaccessible'` when useful; selection
 * treats all three non-`'directory'`/`'linked'` values identically (refuse the
 * candidate).
 */

import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
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

/**
 * Does the resolved gitdir hold a `HEAD`? Discriminates on errno rather than
 * `existsSync`, which reports `false` for an unreadable `.git` exactly as it
 * does for a shell one — collapsing a real checkout behind restrictive ACLs
 * (SMB/NFS mount, another user's clone, a broken mode) onto the
 * moved-away-ghost classification. Same ENOENT/ENOTDIR split `classifyGitEntry`
 * applies one level up.
 */
function readHeadState(gitDir: string): 'present' | 'missing' | 'inaccessible' {
  try {
    statSync(join(gitDir, 'HEAD'));
    return 'present';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'inaccessible';
  }
}

export function readGitDirKind(projectPath: string): ResolvedGitDirKind {
  if (!isAbsolute(projectPath)) return 'absent';
  try {
    const resolved = resolveGitDirDetailed(projectPath);
    if (resolved.kind === 'directory' || resolved.kind === 'linked') {
      if (resolved.projectSubPath !== '') return 'absent';
      try {
        statSync(resolved.path);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        return code === 'ENOENT' || code === 'ENOTDIR' ? 'malformed-pointer' : 'inaccessible';
      }
      const head = readHeadState(resolved.path);
      if (head !== 'present') return head === 'missing' ? 'absent' : 'inaccessible';
    }
    return resolved.kind;
  } catch {
    return 'absent';
  }
}
