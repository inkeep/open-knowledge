import type {
  BranchInfoResponse,
  CheckoutResponse,
  ShareTargetStatusResponse,
  WorktreeCreateResult,
} from '@inkeep/open-knowledge-core';

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
    }
  | {
      readonly action: 'branch-diverged';
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
    case 'ff-diverged':
      return { action: 'branch-diverged' };
    default: {
      const _exhaustive: never = response.reason;
      throw new Error(`Unhandled CheckoutFailureReason: ${String(_exhaustive)}`);
    }
  }
}

type VerdictResolution =
  | { readonly kind: 'on-origin' }
  | { readonly kind: 'renamed'; readonly renamedTo: string }
  | { readonly kind: 'deleted' }
  | { readonly kind: 'never-on-branch' }
  | { readonly kind: 'diverged' };

export type VerdictCellKind = VerdictResolution['kind'];

export type BranchSwitchDialogState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly info: BranchInfoResponse }
  | {
      readonly phase: 'verdict-pending';
      readonly info: BranchInfoResponse;
    }
  | {
      readonly phase: 'verdict';
      readonly info: BranchInfoResponse;
      readonly resolution: VerdictResolution;
    }
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
  | {
      readonly phase: 'creating-worktree';
      readonly info: BranchInfoResponse;
    }
  | {
      readonly phase: 'opening-worktree';
      readonly path: string;
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
  if (state.phase !== 'ready' && state.phase !== 'verdict') return state;
  return { phase: 'switching', info: state.info, pendingDoc };
}

export function markCreatingWorktree(state: BranchSwitchDialogState): BranchSwitchDialogState {
  if (state.phase !== 'ready') return state;
  return { phase: 'creating-worktree', info: state.info };
}

export function shouldProbeTargetStatus(info: BranchInfoResponse): boolean {
  return selectBranchSwitchVariant(info).kind === 'B' && info.shareTargetOnOriginBranch === false;
}

export function markVerdictPending(state: BranchSwitchDialogState): BranchSwitchDialogState {
  if (state.phase !== 'ready') return state;
  return { phase: 'verdict-pending', info: state.info };
}

export function applyVerdict(
  state: BranchSwitchDialogState,
  response: ShareTargetStatusResponse | null,
): BranchSwitchDialogState {
  if (state.phase !== 'verdict-pending') return state;
  if (
    response === null ||
    response.verdict === 'unknown' ||
    response.verdict === 'changed-locally'
  ) {
    return { phase: 'ready', info: state.info };
  }
  const resolution: VerdictResolution =
    response.verdict === 'renamed'
      ? { kind: 'renamed', renamedTo: response.renamedTo }
      : { kind: response.verdict };
  return { phase: 'verdict', info: state.info, resolution };
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
  if (outcome.action === 'branch-diverged') {
    return {
      state: { phase: 'verdict', info: state.info, resolution: { kind: 'diverged' } },
    };
  }
  return {
    state: { phase: 'ready', info: state.info },
    sideEffect: { kind: 'toast', reason: outcome.reason },
  };
}

export type WorktreeCheckoutSideEffectReason =
  | 'proxy-null'
  | Extract<WorktreeCreateResult, { ok: false }>['reason'];

export interface ApplyWorktreeCheckoutOutcomeResult {
  readonly state: BranchSwitchDialogState;
  readonly sideEffect?: {
    readonly kind: 'toast';
    readonly reason: WorktreeCheckoutSideEffectReason;
    readonly helper?: string;
    readonly authFailed?: true;
    readonly notFoundAsIdentity?: true;
  };
}

export function applyWorktreeCheckoutOutcome(
  state: BranchSwitchDialogState,
  result: WorktreeCreateResult | null,
): ApplyWorktreeCheckoutOutcomeResult {
  if (state.phase !== 'creating-worktree') return { state };
  if (result === null) {
    return {
      state: { phase: 'ready', info: state.info },
      sideEffect: { kind: 'toast', reason: 'proxy-null' },
    };
  }
  if (result.ok) {
    return { state: { phase: 'opening-worktree', path: result.path } };
  }
  if (result.reason === 'branch-not-found') {
    return {
      state: { phase: 'dismissed', reason: 'branch-not-found' },
      sideEffect: { kind: 'toast', reason: 'branch-not-found' },
    };
  }
  return {
    state: { phase: 'ready', info: state.info },
    sideEffect: {
      kind: 'toast',
      reason: result.reason,
      helper: result.helper,
      authFailed: result.reason === 'fetch-failed' ? result.authFailed : undefined,
      notFoundAsIdentity: result.reason === 'fetch-failed' ? result.notFoundAsIdentity : undefined,
    },
  };
}
