/**
 * Pure builder for the desktop worktree-selector model.
 *
 * Given the parsed `git worktree list --porcelain` entries (first entry is the
 * repo's main worktree), the local branch list, and the currently-focused
 * window's project path, produce the ordered entry list the sidebar +
 * File-menu selector render. Keeping the merge/ordering logic pure and in
 * `core` lets it ship without a git fixture and stay unit-testable — the
 * desktop main process supplies the IO (spawning git, realpath-collapsing
 * paths) and hands the results here.
 *
 * Mental model (worktree = window): each entry is a branch you can work
 * on in its own window. A branch with a `worktreePath` already has a checked-
 * out worktree (open/focus its window); a branch with `worktreePath: null` has
 * none yet (creating one on demand is the selector's job).
 */

import type { BridgeWorktreeEntry } from './worktree-list-parser.ts';

export interface WorktreeSelectorEntry {
  /** Short branch name. `null` for a detached-HEAD worktree (rare). */
  readonly branch: string | null;
  /**
   * Absolute path of the worktree checked out on this branch, or `null` when
   * no worktree exists for it yet. Realpath-collapsed by the caller.
   */
  readonly worktreePath: string | null;
  /** This entry's worktree is the currently-focused window's project. */
  readonly isCurrent: boolean;
  /** This entry's worktree is the repo's main (primary) worktree. */
  readonly isMain: boolean;
  /** The worktree is locked (`git worktree lock`). */
  readonly locked: boolean;
  /**
   * How many commits this local branch is behind its `origin/<branch>`
   * upstream (READ-ONLY, no-network `git rev-list --count <branch>..origin/<branch>`
   * at model-build). Present only when the branch HAS an upstream and the count
   * is computable; absent (undefined) when there's no upstream, no network fetch
   * has run, or the count couldn't be read. `0` means up-to-date with the last
   * fetch. Surfaced as a "N behind origin" hint on the base selector to nudge the
   * user toward a fresh `origin/<x>` base instead of a stale local one.
   */
  readonly behind?: number;
}

export interface WorktreeSelectorModel {
  /** Absolute path of the repo's main worktree (the `.ok/worktrees/` anchor). */
  readonly mainRoot: string;
  /** Branch of the currently-focused window's project, or `null` if unknown. */
  readonly currentBranch: string | null;
  /** Ordered for display: current first, then main, then the rest. */
  readonly entries: readonly WorktreeSelectorEntry[];
  /**
   * Remote-tracking branch refs WITH their remote prefix (`origin/main`,
   * `origin/feature-x`, `upstream/dev`), deduped + order-preserving,
   * `<remote>/HEAD` symbolic refs excluded. Two consumers in the dialog:
   *   - remote-tracking CHECKOUT: a typed `branch` whose bare name matches one
   *     of these refs but has NO local branch is checked out as a new local
   *     tracking branch (`git worktree add --track -b <name> <path> origin/<name>`),
   *     NOT forked off stale HEAD (which would silently discard remote history).
   *   - remote BASE options: every ref is selectable as a `--no-track` base for
   *     a new branch, so a feature branch can start from fresh `origin/<x>` even
   *     when the local `<x>` is behind.
   * Empty when the repo has no remotes / enumeration failed (fail-soft).
   */
  readonly remoteBranches: readonly string[];
}

/**
 * IPC-facing result of enumerating the worktree selector. Canonical here (not
 * in desktop) so the three `OkDesktopBridge` contract copies + `ipc-channels`
 * all import one definition. `no-git` = the project isn't inside a git repo.
 */
export type WorktreeListResult =
  | { readonly ok: true; readonly model: WorktreeSelectorModel }
  | { readonly ok: false; readonly reason: 'no-git' };

/** Renderer → main request to create (or locate) a worktree for a branch. */
export interface WorktreeCreateRequest {
  /** With `createBranch`, a NEW branch name; otherwise an existing branch. */
  readonly branch: string;
  /**
   * Base ref for a new LOCAL-based branch (defaults to HEAD). Ignored unless
   * `createBranch`, and mutually exclusive with `baseRef` (a remote base). The
   * created branch does NOT track this base (a local base carries no upstream to
   * inherit). Git arm: `git worktree add -b <branch> <path> -- <baseBranch>`.
   */
  readonly baseBranch?: string | null;
  /**
   * Remote-tracking base ref for a new branch (e.g. `origin/main`). Set instead
   * of `baseBranch` when the user picked a remote base in the selector. The new
   * branch is created off this ref WITH `--no-track` — a feature branch must not
   * inherit the base's remote as its own upstream. Ignored unless `createBranch`;
   * takes precedence over `baseBranch` when both are somehow set. Git arm:
   * `git worktree add -b <branch> <path> <baseRef> --no-track`. The ref is a
   * `<remote>/<branch>` string, never a dash-prefixed positional, so it needs no
   * `--` guard (git resolves it as a ref, and the trailing `--no-track` is a flag).
   */
  readonly baseRef?: string | null;
  /**
   * Remote-only checkout ref (e.g. `origin/feature-x`). Set when `branch` names a
   * branch that exists ONLY on a remote (no local branch). The worktree is checked
   * out as a NEW LOCAL branch that TRACKS this remote ref, preserving remote
   * history instead of forking a divergent local branch off stale HEAD. When set,
   * `createBranch` is `true` (a local branch is created) but `baseBranch` /
   * `baseRef` are ignored — the remote ref IS the base. Git arm:
   * `git worktree add --track -b <branch> <path> <remoteRef>`. The explicit ref
   * avoids the multi-remote DWIM `fatal: invalid reference` a bare `-b <branch>`
   * would hit.
   */
  readonly remoteRef?: string | null;
  /** `true` → create a new branch; `false` → check out an existing branch. */
  readonly createBranch: boolean;
}

/**
 * IPC-facing result of creating/locating a worktree. `created: false` means the
 * branch already had a worktree and `path` points at it (open that window
 * instead). The failure reasons map git's refusal modes to actionable copy.
 */
export type WorktreeCreateResult =
  | { readonly ok: true; readonly path: string; readonly created: boolean }
  | {
      readonly ok: false;
      readonly reason:
        | 'invalid-branch'
        | 'branch-exists'
        | 'already-checked-out'
        | 'path-exists'
        | 'no-git'
        | 'error';
      readonly message?: string;
    };

export interface BuildWorktreeSelectorModelInput {
  /**
   * Parsed `git worktree list --porcelain` entries. The first entry is git's
   * main worktree; prunable entries (path gone from disk) are ignored.
   */
  readonly worktrees: readonly BridgeWorktreeEntry[];
  /** Local branch short-names (`git for-each-ref refs/heads/`). */
  readonly branches: readonly string[];
  /** Realpath of the focused window's project — used to flag the current entry. */
  readonly currentProjectPath: string;
  /**
   * Remote-tracking branch short-names WITH their remote prefix
   * (`origin/main`, `upstream/dev`), from `git for-each-ref refs/remotes/` with
   * `<remote>/HEAD` symbolic refs already stripped by the caller. Optional /
   * defaults `[]` (older callers / no remotes). The builder derives the
   * remote-ONLY set (a remote branch whose short-name has no matching local
   * branch) so the dialog can distinguish a remote-tracking checkout from a
   * fresh branch.
   */
  readonly remoteBranches?: readonly string[];
  /**
   * Per-local-branch "behind origin" counts, keyed by local branch short-name.
   * `behind[b] = N` sets that entry's `behind` field. Branches absent from the
   * map (no upstream / uncomputable) get no `behind` field. Optional / defaults
   * `{}`. Computed by the caller via no-network `git rev-list --count b..origin/b`.
   */
  readonly behind?: Readonly<Record<string, number>>;
}

/**
 * Merge worktrees + local branches into one ordered entry list. Every local
 * branch yields an entry (with its worktree path when one exists); every
 * non-prunable worktree whose branch is NOT a local branch (a detached-HEAD
 * worktree) also yields an entry so the current window is always represented.
 */
export function buildWorktreeSelectorModel(
  input: BuildWorktreeSelectorModelInput,
): WorktreeSelectorModel {
  const liveWorktrees = input.worktrees.filter((w) => !w.prunable);
  const mainRoot = liveWorktrees[0]?.path ?? input.currentProjectPath;

  const behind = input.behind ?? {};
  // Full remote-tracking ref list, deduped + order-preserving. Kept whole (not
  // filtered to remote-only) because base options want every `origin/<x>` even
  // when a local `<x>` exists — basing on fresh `origin/main --no-track` is the
  // point. The dialog derives the remote-ONLY subset itself (a ref whose bare
  // name has no local branch → remote-tracking checkout).
  const remoteBranches: string[] = [];
  const seenRemote = new Set<string>();
  for (const ref of input.remoteBranches ?? []) {
    if (ref.length === 0 || seenRemote.has(ref)) continue;
    seenRemote.add(ref);
    remoteBranches.push(ref);
  }

  // branch -> worktree. A branch can be checked out in at most one worktree, so
  // last-wins is a non-issue; first-wins keeps the main worktree if a malformed
  // list ever duplicated a branch.
  const worktreeByBranch = new Map<string, BridgeWorktreeEntry>();
  for (const w of liveWorktrees) {
    if (w.branch !== null && !worktreeByBranch.has(w.branch)) {
      worktreeByBranch.set(w.branch, w);
    }
  }

  const isCurrentPath = (p: string): boolean => p === input.currentProjectPath;

  const entries: WorktreeSelectorEntry[] = [];

  for (const branch of input.branches) {
    const wt = worktreeByBranch.get(branch) ?? null;
    const behindCount = behind[branch];
    entries.push({
      branch,
      worktreePath: wt?.path ?? null,
      isCurrent: wt !== null && isCurrentPath(wt.path),
      isMain: wt !== null && wt.path === mainRoot,
      locked: wt?.locked ?? false,
      // Omit the field entirely when there's no computed count so consumers can
      // distinguish "no upstream / unknown" (undefined) from "up to date" (0).
      ...(behindCount !== undefined ? { behind: behindCount } : {}),
    });
  }

  // Detached-HEAD worktrees (branch === null) aren't in the branch list — add
  // them so a window sitting on a detached checkout still appears (and can be
  // flagged current). Keyed by path to avoid duplicating a branch entry.
  const branchPaths = new Set(
    entries.map((e) => e.worktreePath).filter((p): p is string => p !== null),
  );
  for (const w of liveWorktrees) {
    if (w.branch === null && !branchPaths.has(w.path)) {
      entries.push({
        branch: null,
        worktreePath: w.path,
        isCurrent: isCurrentPath(w.path),
        isMain: w.path === mainRoot,
        locked: w.locked,
      });
    }
  }

  const currentBranch = entries.find((e) => e.isCurrent)?.branch ?? null;

  entries.sort(compareEntries);

  return { mainRoot, currentBranch, entries, remoteBranches };
}

/**
 * Strip the `<remote>/` prefix from a remote-tracking ref short-name, returning
 * the bare branch name. `origin/feature-x` → `feature-x`; `origin/feat/foo` →
 * `feat/foo` (only the FIRST segment is the remote — slashes in the branch name
 * survive). A ref with no slash returns unchanged (defensive; git always emits
 * `<remote>/<name>` here).
 */
export function stripRemotePrefix(ref: string): string {
  const slash = ref.indexOf('/');
  return slash === -1 ? ref : ref.slice(slash + 1);
}

/**
 * Display order: the current entry first, then the main worktree, then
 * worktree-backed branches, then branchless-worktree/detached, then plain
 * branches — each tier alphabetized. Deterministic so the list doesn't jump
 * between reloads.
 */
function compareEntries(a: WorktreeSelectorEntry, b: WorktreeSelectorEntry): number {
  const rank = (e: WorktreeSelectorEntry): number => {
    if (e.isCurrent) return 0;
    if (e.isMain) return 1;
    if (e.worktreePath !== null) return 2;
    return 3;
  };
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  return (a.branch ?? '').localeCompare(b.branch ?? '');
}
