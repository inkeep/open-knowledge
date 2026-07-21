/**
 * Validate that a user-picked folder is a clone of the GitHub repo a share
 * URL points at — drives the "I have it locally →" path on the in-OK receive
 * dialog. The receive dialog calls this
 * after the user picks a folder; on `kind: 'ok'` it registers the folder as
 * a `RecentProject` (with the canonical `gitRemoteUrl`) and opens the doc.
 *
 * Symlink discipline mirrors `discoverProject` in
 * `packages/desktop/src/main/folder-admission.ts`: realpath canonicalize,
 * then verify the picked folder hasn't escaped via a symlink that resolves
 * outside its apparent parent. A `.git` directory that symlinks outside the
 * realpath'd folder is also rejected — the AC's "FR security, inherits OK
 * Worktree pointers (`.git` is a regular file
 * containing `gitdir: <path>`) are exempt from the inside-folder check —
 * legitimate worktrees ALWAYS point at a separate gitdir outside the
 * worktree folder.
 *
 * Owner / repo comparison is case-insensitive: GitHub URLs accept any case
 * combination (`/Inkeep/Open-Knowledge` and `/inkeep/open-knowledge` resolve
 * to the same repo), so a clone whose origin uses different case from the
 * share URL must still match.
 */

import { statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { classifyGitHubShareHost } from '@inkeep/open-knowledge-core';
import { inspectGitRepository } from '@inkeep/open-knowledge-core/git-repository';
import { parseGitUrl } from './url.ts';

/** Outcome of `validateLocalFolderForShare`. Discriminated by `kind`. */
export type ShareFolderValidationResult =
  | { kind: 'ok'; gitRemoteUrl: string }
  | { kind: 'not-git' }
  | { kind: 'no-origin' }
  | { kind: 'wrong-repo'; actualOwner: string; actualRepo: string }
  | { kind: 'wrong-host'; actualHost: string }
  | { kind: 'non-github' }
  | { kind: 'symlink-escape' };

/** Mirrors `ExpectedShareRepo` in `@inkeep/open-knowledge-core` — keep in sync. */
export interface ExpectedShareRepo {
  /** GitHub host the share targets: `github.com` or a GHES hostname. */
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
}

/**
 * Read the repo's `config` (`<folderPath>/.git/config` for a primary checkout;
 * for a git-worktree pointer, the shared common dir's config reached via the
 * worktree gitdir's `commondir` — a linked worktree's gitdir holds no `config`
 * of its own), parse `[remote "origin"]`, and classify against the expected
 * `{owner, repo}` from the share URL.
 *
 * Never throws — every filesystem or parse failure maps to a structured
 * result kind so the caller can render a friendly toast.
 */
export async function validateLocalFolderForShare(
  folderPath: string,
  expected: ExpectedShareRepo,
): Promise<ShareFolderValidationResult> {
  // 1. Realpath-canonicalize the picked folder; verify it didn't escape via
  //    a symlink. Mirrors `discoverProject`'s symlink-escape check.
  let realFolder: string;
  let realParent: string;
  try {
    realFolder = await realpath(resolve(folderPath));
    realParent = await realpath(resolve(dirname(folderPath)));
  } catch {
    return { kind: 'not-git' };
  }
  if (!isDescendantOrEqual(realFolder, realParent)) {
    return { kind: 'symlink-escape' };
  }

  // 2. Locate `.git` (directory in the common case; regular file pointing at
  //    the gitdir for git worktrees).
  const dotGit = join(realFolder, '.git');
  let dotGitStat: ReturnType<typeof statSync>;
  try {
    dotGitStat = statSync(dotGit);
  } catch {
    return { kind: 'not-git' };
  }

  if (dotGitStat.isDirectory()) {
    let realDotGit: string;
    try {
      realDotGit = await realpath(dotGit);
    } catch {
      return { kind: 'not-git' };
    }
    // `.git` directory must live inside the realpath'd folder; a `.git` symlink
    // that escapes (e.g., to `/etc/passwd`) is rejected so we don't mis-parse
    // an arbitrary file as a git config.
    if (!isDescendantOrEqual(realDotGit, realFolder)) {
      return { kind: 'symlink-escape' };
    }
  } else if (!dotGitStat.isFile()) {
    return { kind: 'not-git' };
  }

  // 3. Repository mechanics are shared; this adapter retains the folder-picker's
  //    stricter realpath admission and user-facing failure vocabulary.
  const inspected = inspectGitRepository(realFolder);
  if (inspected.kind !== 'repository') {
    return { kind: 'not-git' };
  }
  const origin = inspected.repository.readRemoteUrl('origin');
  if (origin.kind === 'unreadable') return { kind: 'not-git' };
  if (origin.kind === 'absent') {
    return origin.reason === 'config-missing' ? { kind: 'not-git' } : { kind: 'no-origin' };
  }
  const originUrl = origin.url;

  // 4. Parse origin via the shared `parseGitUrl`. Anything we can't parse
  //    OR that points at a known non-GitHub forge lands as `non-github` —
  //    same downstream surface (the receive dialog renders the "switch your
  //    remote" toast). Unknown hosts are presumed GitHub (GHES) and matched
  //    against the share's host below.
  const parsed = parseGitUrl(originUrl);
  if (parsed === null) return { kind: 'non-github' };
  const foldedHost = classifyGitHubShareHost(parsed.hostname);
  if (foldedHost === null) return { kind: 'non-github' };

  // 5. Compare host + owner/repo case-insensitively (GitHub URL semantics).
  const hostMatch = foldedHost === expected.host.toLowerCase();
  const ownerMatch = parsed.owner.toLowerCase() === expected.owner.toLowerCase();
  const repoMatch = parsed.name.toLowerCase() === expected.repo.toLowerCase();
  //    Same owner/repo but a different host (a github.com clone offered for a
  //    GHES share, or vice versa) is surfaced distinctly so the UI can say
  //    "right repo, wrong server" rather than a misleading "wrong repo".
  if (!hostMatch && ownerMatch && repoMatch) {
    return { kind: 'wrong-host', actualHost: foldedHost };
  }
  if (!hostMatch || !ownerMatch || !repoMatch) {
    return { kind: 'wrong-repo', actualOwner: parsed.owner, actualRepo: parsed.name };
  }

  // 6. Re-emit canonical HTTPS form so the caller's `RecentProject.gitRemoteUrl`
  //    matches the form readCanonicalGitHubRemoteUrl writes elsewhere — both
  //    SSH and HTTPS clones converge on one lookup key.
  return {
    kind: 'ok',
    gitRemoteUrl: `https://${foldedHost}/${parsed.owner}/${parsed.name}.git`,
  };
}

/**
 * `relative(parent, child)` returns `''` for equal paths, a `..`-prefixed
 * string when `child` sits outside `parent`, and a non-`..` relative path
 * when child is a descendant. The early `child === parent` short-circuit is
 * defensive for trailing-slash / OS-quirk equality.
 */
function isDescendantOrEqual(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}
