import { realpathSync } from 'node:fs';
import { type CheckoutFailureReason, isBranchNotFoundGitError } from '@inkeep/open-knowledge-core';
import { truncateError } from './error-format.ts';
import { dirtyFilesOverlapWith } from './git-dirty.ts';
import { createGitInstance } from './git-handle.ts';
import { getLogger } from './logger.ts';

const log = getLogger('git-checkout');

const FF_FETCH_TIMEOUT_MS = 15_000;

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
  opts: { readonly fastForward?: boolean; readonly credentialConfig: string[] },
): Promise<CheckoutOutcome> {
  if (opts.fastForward) {
    const ff = await fastForwardBranchToOrigin(projectDir, branch, opts.credentialConfig);
    if (ff === 'diverged') {
      return { ok: false, reason: 'ff-diverged' };
    }
  }

  const { git } = createGitInstance(projectDir, { credentialConfig: opts.credentialConfig });

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
      log.warn(
        { branch, heldAt: heldElsewhere.path },
        `reason=branch-in-other-worktree branch=${branch} held_at=${heldElsewhere.path}`,
      );
      return {
        ok: false,
        reason: 'branch-in-other-worktree',
        otherWorktreePath: heldElsewhere.path,
      };
    }
    log.warn(
      { branch, err },
      `action=checkout-failed branch=${branch} error=${truncateError(err)}`,
    );
    return { ok: false, reason: 'checkout-failed' };
  }
}

export type FastForwardOutcome = 'advanced' | 'up-to-date' | 'diverged' | 'unavailable';

export async function fastForwardBranchToOrigin(
  projectDir: string,
  branch: string,
  credentialConfig: string[],
): Promise<FastForwardOutcome> {
  const { git } = createGitInstance(projectDir, {
    timeoutMs: FF_FETCH_TIMEOUT_MS,
    credentialConfig,
  });

  const revParse = (ref: string): Promise<string | null> =>
    git
      .raw(['rev-parse', '--verify', ref])
      .then((sha) => sha.trim())
      .catch(() => null);

  try {
    await git.raw(['fetch', 'origin', branch]);
  } catch (err) {
    log.warn(
      { branch, err },
      `action=ff-fetch-failed branch=${branch} error=${truncateError(err)}`,
    );
    return 'unavailable';
  }

  const originTip = await revParse(`refs/remotes/origin/${branch}`);
  if (!originTip) return 'unavailable';

  const localTip = await revParse(`refs/heads/${branch}`);
  if (!localTip || localTip === originTip) return 'up-to-date';

  const mergeBase = await git
    .raw(['merge-base', localTip, originTip])
    .then((sha) => sha.trim())
    .catch(() => '');

  if (mergeBase === localTip) {
    try {
      await git.raw(['fetch', 'origin', `${branch}:${branch}`]);
    } catch (err) {
      log.warn(
        { branch, err },
        `action=ff-advance-failed branch=${branch} error=${truncateError(err)}`,
      );
      return 'unavailable';
    }
    const after = await revParse(`refs/heads/${branch}`);
    return after === originTip ? 'advanced' : 'unavailable';
  }
  if (mergeBase === originTip) return 'up-to-date';
  return 'diverged';
}
