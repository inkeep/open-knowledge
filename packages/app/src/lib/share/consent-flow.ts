/**
 * Consent-dialog state machine for the share-receive flow.
 *
 * Renders for the `launcher-consent` share payload — a worktree on the
 * share's branch exists at `candidatePath` BUT lacks `.ok/config.yml`.
 * The user must opt in to initializing it before silent dispatch can fire;
 * side effects on disk from a link click need user opt-in.
 *
 * State machine (linear; no retries):
 *
 *   ready ──[Initialize]──> initializing ──[ok-init OK]──> opening ──[open OK]──> done
 *                              │                              │
 *                              └─[ok-init fail]─> error       └─[open fail]─> error
 *
 * Cancel from any non-terminal phase ──> cancelled. `error` is terminal for the
 * action button (no retry); the only exit from `error` is Cancel.
 *
 * Pure module — no IPC, no React, no I/O. The reducer-style helpers below
 * are pure and unit-tested so the React component stays declarative. HTTP
 * calls + bridge.open dispatch live in the dialog component; this module
 * only describes transitions.
 *
 * Parent-project context: `parentProjectName` is set when the share-
 * receive Q1 step identified a parent OK project (via `parentRecent.name`).
 * The dialog renders an extra contextual line "a worktree of
 * <parentProjectName>" when this field is set; omits the line otherwise.
 * Source of truth for the resolution lives in the dispatch layer, not
 * here — this module just carries the resolved string through.
 */

export interface ConsentFlowSeed {
  /** Realpath of the candidate worktree that needs initialization. */
  readonly candidatePath: string;
  /** Share's branch — surfaced in the dialog copy + threaded to bridge.open. */
  readonly branch: string;
  /** Share's target path (doc or folder) — threaded to bridge.open as pendingDeepLinkTarget.path. */
  readonly targetPath: string;
  /** Share's target kind — threaded to bridge.open as pendingDeepLinkTarget.kind. */
  readonly targetKind: 'doc' | 'folder';
  /**
   * Parent OK project's display name. When set, the dialog renders
   * "a worktree of <parentProjectName>" as additional context. Null when
   * no Recent for the parent exists or when the candidate is unanchored.
   */
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

/**
 * Mark Initialize-and-open click. Only transitions from `ready` — defensive
 * identity from any other phase so a double-click can't race the ok-init
 * call already in flight.
 */
export function markInitializing(state: ConsentFlowState): ConsentFlowState {
  if (state.phase !== 'ready') return state;
  return { phase: 'initializing', seed: state.seed };
}

/**
 * Apply the ok-init endpoint response (or network error). From
 * `initializing`: success → `opening`; failure → `error`. From any other
 * phase: identity (defensive — a delayed response can't override a Cancel
 * the user already clicked).
 */
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

/**
 * Apply the bridge.open dispatch outcome. From `opening`: success → `done`;
 * failure → `error` (with network-error reason as the closest discriminator
 * for an opaque IPC failure). Identity from any other phase.
 */
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

/**
 * Cancel from any non-terminal phase. Identity from `done` / `cancelled` /
 * `error` — those phases already terminated and Cancel is a no-op (the
 * dialog dismisses regardless).
 */
export function markCancelled(state: ConsentFlowState): ConsentFlowState {
  if (state.phase === 'done' || state.phase === 'cancelled' || state.phase === 'error') {
    return state;
  }
  return { phase: 'cancelled', seed: state.seed };
}
