/**
 * Pure git work for `POST /api/git/checkout` — separated from the HTTP handler
 * so the sequencing (rev-parse → fetch → dirty-check → checkout) is testable
 * without spinning up a server.
 *
 * The handler in `api-extension.ts` wraps `runCheckoutFlow` in `withParentLock`
 * — the lock primitive is intentionally external so this module stays a pure
 * git driver with no transitive imports of the mutex (mirrors how
 * `dirtyFilesOverlapWith` and `computeBranchInfo` stay lock-free).
 *
 * Errors propagate as typed `CheckoutOutcome` values rather than thrown
 * exceptions — the handler maps them 1:1 to the wire envelope discriminator.
 * Unexpected throws still propagate; the handler's top-level catch maps them
 * to a 500 problem+json.
 */

import { realpathSync } from 'node:fs';
import { type CheckoutFailureReason, isBranchNotFoundGitError } from '@inkeep/open-knowledge-core';
import { truncateError } from './error-format.ts';
import { dirtyFilesOverlapWith } from './git-dirty.ts';
import { createGitInstance } from './git-handle.ts';

/**
 * Block timeout for the fast-forward fetches. These run inside `withParentLock`,
 * so a hung fetch would hold the lock indefinitely — bound it (matching the
 * receive-side target-status fetch) so a stalled network degrades to
 * `unavailable` rather than wedging the checkout path.
 */
const FF_FETCH_TIMEOUT_MS = 15_000;

export type CheckoutOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: CheckoutFailureReason;
      files?: string[];
      /** Set iff `reason === 'branch-in-other-worktree'`. Realpath-collapsed. */
      otherWorktreePath?: string;
    };

/**
 * Match git's English-locale stderr for "branch already checked out in
 * another worktree." Capture group 1 holds the worktree path git reported.
 *
 * git phrases this two ways depending on version, so the alternation matches
 * both (LANG=C / LC_ALL=C in `createGitInstance` keeps the locale stable):
 *
 *   fatal: 'feat-bar' is already checked out at '/Users/.../wt/feat-bar'
 *   fatal: 'feat-bar' is already used by worktree at '/Users/.../wt/feat-bar'
 *
 * Older git (e.g. macOS system git) emits "checked out at"; newer git (e.g.
 * the Linux CI image) emits "used by worktree at". Matching only the former
 * silently drops the typed branch-in-other-worktree outcome on newer git,
 * collapsing the in-place pivot into a generic checkout-failed.
 *
 * Branch names with single quotes inside them never reach here — git refuses
 * to create branches with single quotes (`refname` validation). A worktree
 * path containing a single quote is the only pathological case. The `[^']+`
 * path capture is bounded by the surrounding quotes, so such a path is
 * captured truncated at its first inner apostrophe (e.g.
 * `/Users/me/it's-fine/wt` captures as `/Users/me/it`). The truncated path
 * then fails `realpathSync` (or, rarely, resolves to a different existing
 * directory), falling back to the raw truncated path for the pivot display.
 * We deliberately do NOT anchor the closing quote to end-of-line to force a
 * clean miss on such paths: git's stderr can carry trailing `hint:` lines, and
 * an end-anchor would then break detection for ordinary paths. An apostrophe
 * in a worktree path is rare enough that the minor display truncation is an
 * acceptable trade for robust matching of the common case.
 */
const BRANCH_IN_OTHER_WORKTREE_RE =
  /'[^']+' is already (?:checked out|used by worktree) at '([^']+)'/;

/**
 * Detect the git stderr signature for "branch is checked out in another
 * worktree" and extract the realpath-collapsed held-at path. Exported so
 * the regex semantics are unit-testable without spinning up a real git
 * repo. Returns `{ held: false }` on no-match; on match, the caller decides
 * whether to surface the typed outcome or fall through to `checkout-failed`.
 */
export function isBranchInOtherWorktreeError(
  err: unknown,
): { held: true; path: string } | { held: false } {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const match = message.match(BRANCH_IN_OTHER_WORKTREE_RE);
  if (match === null) return { held: false };
  const rawPath = match[1];
  if (rawPath === undefined || rawPath.length === 0) return { held: false };
  // Realpath-collapse so the held-at path matches what listGitWorktrees
  // emits for the same worktree (the renderer compares them). If realpath
  // fails (the worktree was pruned between git's error and our handler
  // running), fall back to the raw path — the dialog still gets useful
  // display text.
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(rawPath);
  } catch {
    canonicalPath = rawPath;
  }
  return { held: true, path: canonicalPath };
}

/** Single source of truth for the handler tag used in logs + telemetry. */
export const CHECKOUT_HANDLER_TAG = 'git-checkout';

/**
 * Returns true when `error` is a simple-git / git CLI failure whose message
 * indicates the requested branch does not exist on the remote.
 *
 * Thin re-export of `isBranchNotFoundGitError` from `@inkeep/open-knowledge-core`
 * — see that function for the canonical pattern. The wrapper here preserves
 * the named export so existing imports (`api-extension.ts`, this module) keep
 * their paths; the implementation is centralized so the cli-side
 * `isBranchNotFoundError` (in `packages/cli/src/commands/clone.ts`) cannot
 * drift from the server-side classifier again.
 *
 * `createGitInstance` spawns git with `LANG=C`/`LC_ALL=C` so stderr is always
 * English regardless of the receiver's host locale. Exported so the
 * LANG-stabilization can be regression-tested without standing up a real
 * git repo.
 */
export const isBranchNotFoundFetchError = isBranchNotFoundGitError;

/**
 * Run the checkout flow against `projectDir` targeting `branch`.
 *
 * Sequencing (each step's result gates the next — sequential by data dep):
 *   1. `git rev-parse --verify refs/heads/<branch>` — branch local?
 *   2. If not local → `git fetch origin <branch>`. Classify fetch failure
 *      via `isBranchNotFoundFetchError` to discriminate
 *      `branch-not-found` vs `fetch-failed`.
 *   3. `dirtyFilesOverlapWith(projectDir, branch)` — re-check on the
 *      authoritative refs after a successful fetch (the fetch may have
 *      advanced refs and changed the overlap set).
 *   4. `git checkout <branch>` — return `ok: true` on success,
 *      `checkout-failed` on any thrown error.
 *
 * No internal try/catch wraps the whole flow — errors at each step are
 * either mapped to a typed outcome (steps 2, 4) or propagated to the
 * handler boundary for the catch-all 500 path.
 *
 * `opts.fastForward` prepends a fast-forward-only update of the target
 * branch's local ref to origin's tip (step 0). It runs inside the same
 * caller-held lock as the checkout so the ref move and the switch are atomic.
 * On divergence the update is refused and `ff-diverged` short-circuits the
 * flow WITHOUT checking out — the receive flow never merges. On a successful
 * advance the branch is now local, so the fetch in step 2 is skipped and the
 * dirty re-check in step 3 runs against the fast-forwarded tip.
 */
export async function runCheckoutFlow(
  projectDir: string,
  branch: string,
  opts?: { readonly fastForward?: boolean },
): Promise<CheckoutOutcome> {
  if (opts?.fastForward) {
    const ff = await fastForwardBranchToOrigin(projectDir, branch);
    if (ff === 'diverged') {
      return { ok: false, reason: 'ff-diverged' };
    }
  }

  const { git } = createGitInstance(projectDir);

  const branchIsLocal = await git
    .raw(['rev-parse', '--verify', `refs/heads/${branch}`])
    .then(() => true)
    .catch(() => false);

  if (!branchIsLocal) {
    try {
      await git.raw(['fetch', 'origin', branch]);
    } catch (err) {
      return {
        ok: false,
        reason: isBranchNotFoundFetchError(err) ? 'branch-not-found' : 'fetch-failed',
      };
    }
  }

  // Re-check dirty overlap against the ref git will actually switch to.
  // When the branch is local, that ref is `refs/heads/<branch>`; when we
  // just fetched, the local ref doesn't exist yet and `dirtyFilesOverlapWith`
  // would fail to resolve `<branch>` — fall back to `origin/<branch>` (the
  // ref the fetch populated), which is the same commit `git checkout` will
  // auto-track from.
  const targetRef = branchIsLocal ? branch : `origin/${branch}`;
  const overlap = await dirtyFilesOverlapWith(projectDir, targetRef);
  if (overlap.conflicts) {
    return { ok: false, reason: 'dirty-conflict', files: overlap.files };
  }

  try {
    await git.raw(['checkout', branch]);
    return { ok: true };
  } catch (err) {
    // Discriminate "branch is checked out in another worktree" — git refuses
    // the checkout in that case, and the multi-worktree share-receive flow
    // pivots the dialog to "Open that worktree instead". The classifier
    // returns `held: false` on any non-match, falling through to the legacy
    // `checkout-failed` catch-all without functional regression.
    const heldElsewhere = isBranchInOtherWorktreeError(err);
    if (heldElsewhere.held) {
      console.warn(
        `[git-checkout] reason=branch-in-other-worktree branch=${branch} held_at=${heldElsewhere.path}`,
      );
      return {
        ok: false,
        reason: 'branch-in-other-worktree',
        otherWorktreePath: heldElsewhere.path,
      };
    }
    // Symmetric observability with the fetch-failure path above: precondition
    // gates (rev-parse, fetch, dirty-overlap) all passed, so the most likely
    // causes are lock contention, filesystem permissions, or partial merge
    // state — which are the hardest to reproduce without a stderr breadcrumb.
    const truncated = truncateError(err);
    console.warn(`[git-checkout] action=checkout-failed branch=${branch} error=${truncated}`);
    return { ok: false, reason: 'checkout-failed' };
  }
}

/**
 * Outcome of {@link fastForwardBranchToOrigin}.
 *
 * - `advanced` — the local branch was fast-forwarded to origin's tip (ref move
 *   only; verified by re-reading the ref).
 * - `up-to-date` — the local branch already contains origin's tip (equal, or
 *   ahead with unpushed commits), or isn't local yet (checkout will create it
 *   at origin's tip). Nothing to update.
 * - `diverged` — the local branch and origin have diverged (neither is an
 *   ancestor of the other). REFUSED: nothing mutated. The receive flow never
 *   merges — reconciliation is the sync engine's job.
 * - `unavailable` — the initial fetch failed, origin's ref couldn't be resolved
 *   (offline / branch not on origin), or the fast-forward advance did not reach
 *   origin's tip (a rare origin-moved-again race). Callers fall back to today's
 *   behavior; any ref move that did land was still a fast-forward.
 */
export type FastForwardOutcome = 'advanced' | 'up-to-date' | 'diverged' | 'unavailable';

/**
 * Fast-forward-only pre-checkout update of a NOT-checked-out branch to origin's
 * tip. First fetches origin's branch into the remote-tracking ref (working tree
 * and `refs/heads` untouched) to learn origin's tip, then advances
 * `refs/heads/<branch>` ONLY when the local tip is a strict ancestor of it. The
 * advance is a fast-forward-only `git fetch origin <branch>:<branch>`: git
 * refuses a non-fast-forward ref update without `--force`, so even a regression
 * in the ancestry classification below could never rewrite the branch
 * non-linearly. The branch is not checked out, so the ref move never touches the
 * working tree; it is never a merge or rebase. Divergence is refused with
 * nothing mutated; the sync engine owns reconciliation.
 *
 * The advance is VERIFIED by re-reading the ref rather than trusting any exit
 * code, and the ancestry check uses `git merge-base` (which signals via stdout)
 * rather than `merge-base --is-ancestor` (exit-code-only, which simple-git
 * cannot branch on — it rejects on stderr, not exit status). merge-base also
 * distinguishes "local is ahead (up-to-date)" from "diverged (refuse)" — a
 * rejected fast-forward fetch alone cannot tell those apart.
 *
 * PRECONDITION: `branch` must not be the checked-out branch. `git` refuses to
 * move the current branch's ref this way; callers FF the TARGET branch before
 * switching to it, so it is never HEAD.
 */
export async function fastForwardBranchToOrigin(
  projectDir: string,
  branch: string,
): Promise<FastForwardOutcome> {
  const { git } = createGitInstance(projectDir, { timeoutMs: FF_FETCH_TIMEOUT_MS });

  const revParse = (ref: string): Promise<string | null> =>
    git
      .raw(['rev-parse', '--verify', ref])
      .then((sha) => sha.trim())
      .catch(() => null);

  try {
    await git.raw(['fetch', 'origin', branch]);
  } catch (err) {
    const truncated = truncateError(err);
    console.warn(`[git-checkout] action=ff-fetch-failed branch=${branch} error=${truncated}`);
    return 'unavailable';
  }

  const originTip = await revParse(`refs/remotes/origin/${branch}`);
  if (!originTip) return 'unavailable';

  const localTip = await revParse(`refs/heads/${branch}`);
  // Not local yet — checkout will create it at origin's tip; nothing to FF.
  if (!localTip || localTip === originTip) return 'up-to-date';

  // `git merge-base <a> <b>` prints the best common ancestor on stdout; when it
  // equals the local tip, local is strictly behind origin (fast-forwardable).
  const mergeBase = await git
    .raw(['merge-base', localTip, originTip])
    .then((sha) => sha.trim())
    .catch(() => '');

  if (mergeBase === localTip) {
    // Fast-forwardable. git's fetch refuses a non-fast-forward ref update, so a
    // rejection or network failure here (e.g. origin advanced to a non-FF tip
    // between the two fetches) throws and degrades to `unavailable` — never a
    // merge, never a forced move.
    try {
      await git.raw(['fetch', 'origin', `${branch}:${branch}`]);
    } catch (err) {
      const truncated = truncateError(err);
      console.warn(`[git-checkout] action=ff-advance-failed branch=${branch} error=${truncated}`);
      return 'unavailable';
    }
    const after = await revParse(`refs/heads/${branch}`);
    return after === originTip ? 'advanced' : 'unavailable';
  }
  // Local already contains origin's tip (ahead with unpushed commits).
  if (mergeBase === originTip) return 'up-to-date';
  // Genuinely diverged — refuse, mutate nothing.
  return 'diverged';
}
