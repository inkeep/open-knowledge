import type { BranchInfoResponse, CheckoutResponse } from '@inkeep/open-knowledge-core';

export type BranchSwitchVariant =
  | {
      readonly kind: 'A';
      readonly openCurrentEnabled: true;
      readonly switchEnabled: true;
      readonly conflictingFiles: readonly string[];
    }
  | {
      readonly kind: 'B';
      readonly openCurrentEnabled: false;
      readonly switchEnabled: true;
      readonly conflictingFiles: readonly string[];
    }
  | {
      readonly kind: 'C';
      readonly openCurrentEnabled: true;
      readonly switchEnabled: false;
      readonly conflictingFiles: readonly string[];
    }
  | {
      readonly kind: 'D';
      readonly openCurrentEnabled: false;
      readonly switchEnabled: false;
      readonly conflictingFiles: readonly string[];
    };

export function selectBranchSwitchVariant(info: BranchInfoResponse): BranchSwitchVariant {
  const targetExists = info.shareTargetExists;
  const dirty = info.dirtyConflicts.conflicts;
  const files = info.dirtyConflicts.files;
  if (targetExists && !dirty) {
    return { kind: 'A', openCurrentEnabled: true, switchEnabled: true, conflictingFiles: files };
  }
  if (!targetExists && !dirty) {
    return { kind: 'B', openCurrentEnabled: false, switchEnabled: true, conflictingFiles: files };
  }
  if (targetExists && dirty) {
    return { kind: 'C', openCurrentEnabled: true, switchEnabled: false, conflictingFiles: files };
  }
  return { kind: 'D', openCurrentEnabled: false, switchEnabled: false, conflictingFiles: files };
}

export function formatCurrentLabel(info: BranchInfoResponse): string {
  if (info.detached) {
    return info.currentHeadSha;
  }
  return info.currentBranch ?? 'HEAD';
}

export type CheckoutOutcome =
  | { readonly action: 'await-cc1' }
  | { readonly action: 'dismiss-with-toast'; readonly reason: 'branch-not-found' }
  | {
      readonly action: 'stay-with-toast';
      readonly reason: 'fetch-failed' | 'checkout-failed';
    }
  | { readonly action: 'rerender-conflict'; readonly files: readonly string[] }
  | {
      readonly action: 'pivot-to-other-worktree';
      readonly otherWorktreePath: string;
    };

export function classifyCheckoutOutcome(response: CheckoutResponse): CheckoutOutcome {
  if (response.ok) {
    return { action: 'await-cc1' };
  }
  switch (response.reason) {
    case 'dirty-conflict':
      return { action: 'rerender-conflict', files: response.files ?? [] };
    case 'branch-not-found':
      return { action: 'dismiss-with-toast', reason: 'branch-not-found' };
    case 'fetch-failed':
    case 'checkout-failed':
      return { action: 'stay-with-toast', reason: response.reason };
    case 'branch-in-other-worktree': {
      const path = response.otherWorktreePath;
      if (path === undefined || path.length === 0) {
        return { action: 'stay-with-toast', reason: 'checkout-failed' };
      }
      return { action: 'pivot-to-other-worktree', otherWorktreePath: path };
    }
    default: {
      const _exhaustive: never = response.reason;
      throw new Error(`Unhandled CheckoutFailureReason: ${String(_exhaustive)}`);
    }
  }
}

export type BranchSwitchDialogState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly info: BranchInfoResponse }
  | {
      readonly phase: 'switching';
      readonly info: BranchInfoResponse;
      readonly pendingDoc: string;
    }
  | {
      readonly phase: 'awaiting-cc1-recycle';
      readonly pendingDoc: string;
    }
  | {
      readonly phase: 'branch-in-other-worktree';
      readonly info: BranchInfoResponse;
      readonly otherWorktreePath: string;
      readonly pendingDoc: string;
    }
  | { readonly phase: 'error' }
  | { readonly phase: 'dismissed'; readonly reason: 'branch-not-found' };

export const initialBranchSwitchState: BranchSwitchDialogState = { phase: 'loading' };

export function applyBranchInfo(
  state: BranchSwitchDialogState,
  info: BranchInfoResponse | null,
): BranchSwitchDialogState {
  if (state.phase !== 'loading') return state;
  if (info === null) return { phase: 'error' };
  return { phase: 'ready', info };
}

export function markSwitching(
  state: BranchSwitchDialogState,
  pendingDoc: string,
): BranchSwitchDialogState {
  if (state.phase !== 'ready') return state;
  return { phase: 'switching', info: state.info, pendingDoc };
}

export type CheckoutSideEffectReason =
  | 'proxy-null'
  | 'fetch-failed'
  | 'checkout-failed'
  | 'branch-not-found';

export interface ApplyCheckoutOutcomeResult {
  readonly state: BranchSwitchDialogState;
  readonly sideEffect?: { readonly kind: 'toast'; readonly reason: CheckoutSideEffectReason };
}

export function applyCheckoutOutcome(
  state: BranchSwitchDialogState,
  response: CheckoutResponse | null,
): ApplyCheckoutOutcomeResult {
  if (state.phase !== 'switching') return { state };
  if (response === null) {
    return {
      state: { phase: 'ready', info: state.info },
      sideEffect: { kind: 'toast', reason: 'proxy-null' },
    };
  }
  const outcome = classifyCheckoutOutcome(response);
  if (outcome.action === 'await-cc1') {
    return { state: { phase: 'awaiting-cc1-recycle', pendingDoc: state.pendingDoc } };
  }
  if (outcome.action === 'rerender-conflict') {
    return {
      state: {
        phase: 'ready',
        info: {
          ...state.info,
          dirtyConflicts: { conflicts: true, files: outcome.files.slice() },
        },
      },
    };
  }
  if (outcome.action === 'pivot-to-other-worktree') {
    return {
      state: {
        phase: 'branch-in-other-worktree',
        info: state.info,
        otherWorktreePath: outcome.otherWorktreePath,
        pendingDoc: state.pendingDoc,
      },
    };
  }
  if (outcome.action === 'dismiss-with-toast') {
    return {
      state: { phase: 'dismissed', reason: outcome.reason },
      sideEffect: { kind: 'toast', reason: outcome.reason },
    };
  }
  return {
    state: { phase: 'ready', info: state.info },
    sideEffect: { kind: 'toast', reason: outcome.reason },
  };
}
