export interface ConsentFlowSeed {
  readonly candidatePath: string;
  readonly branch: string;
  readonly targetPath: string;
  readonly targetKind: 'doc' | 'folder';
  readonly parentProjectName: string | null;
}

export type ConsentFlowState =
  | { readonly phase: 'ready'; readonly seed: ConsentFlowSeed }
  | { readonly phase: 'initializing'; readonly seed: ConsentFlowSeed }
  | { readonly phase: 'opening'; readonly seed: ConsentFlowSeed }
  | {
      readonly phase: 'error';
      readonly seed: ConsentFlowSeed;
      readonly reason: 'not-a-git-worktree' | 'init-failed' | 'network-error';
      readonly message: string;
    }
  | { readonly phase: 'cancelled'; readonly seed: ConsentFlowSeed }
  | { readonly phase: 'done'; readonly seed: ConsentFlowSeed };

export const initialConsentFlowState = (seed: ConsentFlowSeed): ConsentFlowState => ({
  phase: 'ready',
  seed,
});

export function markInitializing(state: ConsentFlowState): ConsentFlowState {
  if (state.phase !== 'ready') return state;
  return { phase: 'initializing', seed: state.seed };
}

export function applyOkInitOutcome(
  state: ConsentFlowState,
  outcome:
    | { readonly ok: true; readonly projectPath: string }
    | {
        readonly ok: false;
        readonly reason: 'not-a-git-worktree' | 'init-failed';
        readonly message: string;
      }
    | { readonly ok: false; readonly reason: 'network-error'; readonly message: string },
): ConsentFlowState {
  if (state.phase !== 'initializing') return state;
  if (outcome.ok) {
    return { phase: 'opening', seed: state.seed };
  }
  return {
    phase: 'error',
    seed: state.seed,
    reason: outcome.reason,
    message: outcome.message,
  };
}

export function applyOpenOutcome(
  state: ConsentFlowState,
  outcome: { readonly ok: true } | { readonly ok: false; readonly message: string },
): ConsentFlowState {
  if (state.phase !== 'opening') return state;
  if (outcome.ok) {
    return { phase: 'done', seed: state.seed };
  }
  return {
    phase: 'error',
    seed: state.seed,
    reason: 'network-error',
    message: outcome.message,
  };
}

export function markCancelled(state: ConsentFlowState): ConsentFlowState {
  if (state.phase === 'done' || state.phase === 'cancelled' || state.phase === 'error') {
    return state;
  }
  return { phase: 'cancelled', seed: state.seed };
}
