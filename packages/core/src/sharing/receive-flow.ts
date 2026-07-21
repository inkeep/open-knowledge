/**
 * Pure share-receive helpers + the shared types they read.
 *
 * Lives in core so the selection algorithm and the data shapes it reads stay
 * in one place, independent of which process runs them. Main (`url-scheme.ts`'s
 * `routeShare`) is the only production caller today — the renderer consumes an
 * already-resolved share target rather than re-running selection.
 *
 * No IPC, no React, no I/O, no `node:*` — browser+Node pure. Tests stub the
 * bridge surface directly.
 */

/**
 * Outcome of `bridge.project.readHeadBranch(projectPath)`. The all-null +
 * `detached: false` shape is the "couldn't determine" sentinel — callers
 * fall back to silent dispatch as if no branch check had been attempted.
 */
export interface HeadBranchInfo {
  readonly currentBranch: string | null;
  readonly headSha: string | null;
  readonly detached: boolean;
}

/**
 * Classification of `<path>/.git`. A producer MUST answer the path-exact
 * question — "is a branch checked out at THIS path" — classifying `<path>/.git`
 * itself and never an ancestor's, and never reporting a working tree it has not
 * verified is one. Selection's guarantee that a branch-match is a real checkout
 * holds only as far as that obligation does. Main's `readGitDirKind` is the
 * reference implementation.
 *
 * `'directory'` is a real `.git/` (main checkout — safe to `git checkout`) and
 * `'linked'` is a `.git` file pointing at a live worktree gitdir; these two are
 * the working trees. `'absent'` means no working tree at this exact path: no
 * `.git`, or a `.git` belonging only to an ancestor, or a `.git/` with no HEAD.
 * `'malformed-pointer'` is a `.git` file that doesn't parse, or one that parses
 * but whose target gitdir is gone. `'inaccessible'` is a `.git` that exists but
 * can't be read.
 */
export type ResolvedGitDirKind =
  | 'directory'
  | 'linked'
  | 'absent'
  | 'malformed-pointer'
  | 'inaccessible';

/**
 * Recent-projects row. `missing` is set at read time by main (folder was
 * absent when the list was assembled). `gitRemoteUrl` is the canonical
 * `https://github.com/<owner>/<repo>.git` form when available (open-time
 * backfill from `.git/config`).
 */
export interface RecentProjectEntry {
  path: string;
  name: string;
  lastOpenedAt: string;
  missing?: boolean;
  gitRemoteUrl?: string;
  /**
   * Git-worktree relationship, computed at list-time (not persisted) so the
   * project switcher can nest linked worktrees under their main project.
   * Absent for non-git projects. `gitCommonDir` is the repo identity shared by
   * all worktrees; `mainRoot` is the repo's main worktree root; `branch` is the
   * checked-out branch (null on detached HEAD).
   */
  gitCommonDir?: string;
  mainRoot?: string;
  isLinkedWorktree?: boolean;
  branch?: string | null;
}

export interface ExpectedShareRepo {
  /** GitHub host the share's repo lives on: `github.com` or a GHES hostname. */
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
}

/**
 * Canonical GitHub remote URL used as the share-receive lookup key. Matches
 * the form `readCanonicalGitHubRemoteUrl` writes during open-time backfill
 * and `validateLocalFolderForShare` returns, so SSH-cloned and HTTPS-cloned
 * receivers converge on a single key. The host is part of the key: a GHES
 * `acme/kb` and a github.com `acme/kb` are different repositories and must
 * never match the same local clone.
 */
export function canonicalGitHubRemoteUrl(expected: ExpectedShareRepo): string {
  return `https://${expected.host}/${expected.owner}/${expected.repo}.git`;
}

function normalizeForMatch(url: string): string {
  let normalized = url.toLowerCase().trim();
  if (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  if (normalized.endsWith('.git')) normalized = normalized.slice(0, -4);
  return normalized;
}

/**
 * Enumerate every non-missing `RecentProjectEntry` whose `gitRemoteUrl`
 * matches the expected `{owner, repo}` (case-insensitive on owner/repo,
 * ignores `.git` suffix differences), preserving Recents order.
 *
 * Skips entries marked `missing: true` so a stale recent doesn't dispatch
 * into a vanished folder, and entries without a `gitRemoteUrl` (legacy
 * pre-backfill or non-git projects).
 */
export function findRecentProjectsForRepo(
  recents: readonly RecentProjectEntry[],
  expected: ExpectedShareRepo,
): RecentProjectEntry[] {
  const target = normalizeForMatch(canonicalGitHubRemoteUrl(expected));
  const matches: RecentProjectEntry[] = [];
  for (const entry of recents) {
    if (entry.missing === true) continue;
    if (!entry.gitRemoteUrl) continue;
    if (normalizeForMatch(entry.gitRemoteUrl) === target) matches.push(entry);
  }
  return matches;
}

/**
 * Outcome of comparing the share's branch against the matched project's
 * `.git/HEAD`. Pure — separated from the bridge-calling wrapper so the
 * decision logic is unit-testable.
 *
 * `'true'` — share carries no branch (legacy URL), OR HEAD read is the
 * graceful-fail sentinel, OR `currentBranch === shareBranch`. Caller
 * silent-dispatches as if a match.
 * `'false'` — HEAD is on a named branch that differs from the share's.
 * `'detached'` — HEAD is detached; treated as a mismatch with the
 * branch-switch dialog handling the short-SHA label.
 */
export type BranchMatchOutcome = 'true' | 'false' | 'detached';

export function classifyBranchMatch(
  shareBranch: string | null | undefined,
  head: HeadBranchInfo,
): BranchMatchOutcome {
  if (!shareBranch || shareBranch.length === 0) return 'true';
  if (head.detached) return 'detached';
  if (head.currentBranch === null) return 'true';
  return head.currentBranch === shareBranch ? 'true' : 'false';
}
