
import { realpathSync } from 'node:fs';
import { type CheckoutFailureReason, isBranchNotFoundGitError } from '@inkeep/open-knowledge-core';
import { dirtyFilesOverlapWith } from './git-dirty.ts';
import { createGitInstance } from './git-handle.ts';

export type CheckoutOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: CheckoutFailureReason;
      files?: string[];
      otherWorktreePath?: string;
    };

const BRANCH_IN_OTHER_WORKTREE_RE =
  /'[^']+' is already (?:checked out|used by worktree) at '([^']+)'/;

export function isBranchInOtherWorktreeError(
  err: unknown,
): { held: true; path: string } | { held: false } {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const match = message.match(BRANCH_IN_OTHER_WORKTREE_RE);
  if (match === null) return { held: false };
  const rawPath = match[1];
  if (rawPath === undefined || rawPath.length === 0) return { held: false };
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(rawPath);
  } catch {
    canonicalPath = rawPath;
  }
  return { held: true, path: canonicalPath };
}

export const CHECKOUT_HANDLER_TAG = 'git-checkout';

export const isBranchNotFoundFetchError = isBranchNotFoundGitError;

export async function runCheckoutFlow(
  projectDir: string,
  branch: string,
): Promise<CheckoutOutcome> {
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

  const targetRef = branchIsLocal ? branch : `origin/${branch}`;
  const overlap = await dirtyFilesOverlapWith(projectDir, targetRef);
  if (overlap.conflicts) {
    return { ok: false, reason: 'dirty-conflict', files: overlap.files };
  }

  try {
    await git.raw(['checkout', branch]);
    return { ok: true };
  } catch (err) {
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
    const message = err instanceof Error ? err.message : String(err);
    const truncated = message.length > 500 ? `${message.slice(0, 500)}…` : message;
    console.warn(`[git-checkout] action=checkout-failed branch=${branch} error=${truncated}`);
    return { ok: false, reason: 'checkout-failed' };
  }
}
