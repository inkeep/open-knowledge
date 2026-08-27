/**
 * The landing controller: the single scroll writer during a mode-switch landing.
 *
 * A landing dispatched into a freshly-flipped editor cannot land in one write.
 * The incoming editor's content has no layout at dispatch time (the outgoing
 * mode was `content-visibility: hidden` and out of flow), so a scrollTop written
 * before layout runs clamps against a stale `scrollHeight`; and as virtualized
 * blocks above the target materialize, the target's real position keeps moving.
 * This controller owns the settle contract that resolves that: dispatch
 * immediately, verify on layout signals, re-dispatch on drift, and terminate in
 * exactly one of four ways — land, cancel on the user's own scroll intent,
 * cancel because an explicit navigation superseded it, or abandon after a
 * bounded window with a diagnostic mark.
 *
 * It is the single writer for its window: it holds the scroll-restore
 * suppression handle (so `ScrollPreservingContainer` and the other gated writers
 * stand down) and turns off the browser's own scroll anchoring, releasing both
 * on every terminal path. Being the single writer is a claim it has to be able
 * to LOSE, though — a user who clicks a Problems row mid-settle is not drift —
 * so it also registers as the document's landing scroll owner, and a
 * position-preserving toggle is superseded there by any explicit navigation.
 * Geometry is injected via `measureTarget`, so the controller is
 * representation-agnostic — a WYSIWYG caller measures with `coordsAtPos`, a
 * source caller through CodeMirror, and this file never touches either editor's
 * internals.
 */

import { mark } from '@/lib/perf';
import type { ResolveConfidence } from './mode-switch-position-resolver';
import {
  acquireScrollRestoreSuppression,
  registerLandingScrollOwner,
  writeLandingResult,
} from './scroll-restore-coordination';
import type { EditorModeValue } from './use-editor-mode';

/**
 * Content-space geometry of the landing target: the distance of its top from the
 * top of the scroll content, and its rendered height. Both are re-read on every
 * verification pass so a landing re-centers as blocks above it materialize.
 */
export interface TargetMetrics {
  top: number;
  height: number;
}

/**
 * Where the target sits in the readable area. `center` puts its geometric center
 * at the center of the region below the toolbar (an explicit jump); `top` pins
 * its top just below the toolbar (a plain toggle preserving the topmost block).
 */
export type LandingPlacement = 'center' | 'top';

/**
 * What the landing is FOR, which decides whether it can be pre-empted. A
 * `toggle` preserves the position the user already had, so any explicit
 * navigation outranks it; a `jump` is itself an explicit navigation and holds
 * the scroller until it terminates on its own.
 */
type LandingIntent = 'toggle' | 'jump';

/**
 * Why an in-flight landing stopped short of settling. Every reason has a
 * producer: the controller raises `user-scroll` itself, the callers' effect
 * cleanup raises `mode-flip` — which is also how a document navigation arrives,
 * since the same effect is keyed on the document — and an explicit navigation
 * taking the scroller through `runScrollNavigation` raises `superseded`.
 */
export type LandingCancelReason = 'user-scroll' | 'mode-flip' | 'superseded';

/** How a landing terminated — every landing produces exactly one of these. */
export type LandingOutcome =
  | { status: 'landed'; delta: number }
  | { status: 'cancelled'; reason: LandingCancelReason }
  | { status: 'abandoned'; delta: number };

export interface StartLandingParams {
  docName: string;
  /** The shared per-document scroller (the one true scrollport in both modes). */
  container: HTMLElement;
  /**
   * The element whose resize signals a content-layout shift. The scroller itself
   * is sized by its parent and does not resize when `scrollHeight` grows inside
   * it, so the observer must watch the growing content column, not the scroller.
   * Defaults to the scroller's first element child.
   */
  contentColumn?: HTMLElement | null;
  /**
   * Current content-space geometry of the target, or null while the incoming
   * editor is still mounting and the target is not yet measurable.
   */
  measureTarget: () => TargetMetrics | null;
  placement: LandingPlacement;
  /**
   * Stated by every caller rather than derived from `placement`: placement is
   * geometry, and a precedence rule keyed on geometry breaks silently the first
   * time a jump wants a top-aligned landing.
   */
  intent: LandingIntent;
  grade: ResolveConfidence;
  /** The mode this landing lands in — stamped on the persisted result so a
   *  later re-activation in a different mode floors instead of driving it. */
  landedMode: EditorModeValue;
  /** When the landing accompanies a mode flip, emits the transition mark. */
  transition?: { from: EditorModeValue; to: EditorModeValue };
  /** Height of the fixed toolbar overlay occluding the top of the scroller. */
  toolbarOffset?: number;
  /** Re-dispatch when the current scroll drifts beyond this from the target. */
  driftThresholdPx?: number;
  /** Settle once no further correction happens for this long (trailing edge). */
  quietMs?: number;
  /** Give up this long after dispatch if the target never settles. */
  abandonAfterMs?: number;
  onOutcome?: (outcome: LandingOutcome) => void;
  /**
   * Discard the durable pending-navigation entry when the landing is cancelled
   * by the caller's effect cleanup (`mode-flip` — a mode flip or a document
   * navigation), so a stale target cannot replay on a later entry. Not invoked
   * on a user-scroll or superseded cancel: the queued intent was already
   * consumed to start this landing, and the user simply took over.
   */
  onDiscardQueuedTarget?: () => void;
}

export interface LandingHandle {
  cancel(reason: LandingCancelReason): void;
}

// Mirrors SourceEditor's TOOLBAR_OVERLAP_PX; real callers pass that constant, so
// this default only covers a caller that omits it. Numeric tuning knobs below
// are intentionally overridable and read out through the ok/landing/* marks.
const DEFAULT_TOOLBAR_OFFSET_PX = 56;
const DEFAULT_DRIFT_THRESHOLD_PX = 2;
const DEFAULT_SETTLE_QUIET_MS = 150;
const DEFAULT_ABANDON_MS = 2000;

/**
 * Scroll offset that centers `metrics` in the readable region below the toolbar.
 * The readable region spans `[toolbarOffset, viewportHeight]`, so its center is
 * `(toolbarOffset + viewportHeight) / 2`; placing the target's center there gives
 * this offset. The half-toolbar bias is the definition of centered here, not a
 * tolerance — a landing is centered when it lands exactly on this value.
 */
export function centeredScrollTop(
  metrics: TargetMetrics,
  viewportHeight: number,
  toolbarOffset: number,
): number {
  return metrics.top + metrics.height / 2 - (toolbarOffset + viewportHeight) / 2;
}

function clampScroll(value: number, container: HTMLElement): number {
  const max = Math.max(0, container.scrollHeight - container.clientHeight);
  return Math.max(0, Math.min(value, max));
}

export function startLanding(params: StartLandingParams): LandingHandle {
  const {
    docName,
    container,
    measureTarget,
    placement,
    intent,
    grade,
    landedMode,
    transition,
    onOutcome,
    onDiscardQueuedTarget,
    toolbarOffset = DEFAULT_TOOLBAR_OFFSET_PX,
    driftThresholdPx = DEFAULT_DRIFT_THRESHOLD_PX,
    quietMs = DEFAULT_SETTLE_QUIET_MS,
    abandonAfterMs = DEFAULT_ABANDON_MS,
  } = params;
  const contentColumn = params.contentColumn ?? container.firstElementChild;

  const suppression = acquireScrollRestoreSuppression(docName, 'landing');
  const scrollOwner = registerLandingScrollOwner(docName, {
    yieldsToNavigation: intent === 'toggle',
    supersede: () => cancel('superseded'),
  });
  // Scroll anchoring would re-adjust scrollTop as blocks above the target grow,
  // fighting the settle write for write; hold it off for the whole window.
  const priorOverflowAnchor = container.style.overflowAnchor;
  container.style.overflowAnchor = 'none';

  if (transition) {
    mark('ok/mode-switch/transition', { from: transition.from, to: transition.to, grade });
  }

  let closed = false;
  let lastTarget: number | null = null;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let abandonTimer: ReturnType<typeof setTimeout> | undefined;
  let raf = 0;
  let resizeObserver: ResizeObserver | undefined;

  const currentTarget = (): number | null => {
    const m = measureTarget();
    if (m === null) return null;
    const raw =
      placement === 'center'
        ? centeredScrollTop(m, container.clientHeight, toolbarOffset)
        : m.top - toolbarOffset;
    return clampScroll(raw, container);
  };

  // Apply the target when it is measurable and has drifted past the threshold.
  // Reports whether a target was measurable at all, and whether it moved.
  const dispatch = (): { measurable: boolean; moved: boolean } => {
    const target = currentTarget();
    if (target === null) return { measurable: false, moved: false };
    lastTarget = target;
    const moved = Math.abs(container.scrollTop - target) > driftThresholdPx;
    if (moved) container.scrollTop = target;
    return { measurable: true, moved };
  };

  const finalDelta = (): number =>
    container.scrollTop - (currentTarget() ?? lastTarget ?? container.scrollTop);

  const teardown = (): void => {
    if (quietTimer) clearTimeout(quietTimer);
    if (abandonTimer) clearTimeout(abandonTimer);
    if (raf) cancelAnimationFrame(raf);
    resizeObserver?.disconnect();
    container.removeEventListener('wheel', onUserInterrupt);
    container.removeEventListener('touchstart', onUserInterrupt);
    container.removeEventListener('contentvisibilityautostatechange', onSignal, true);
    container.style.overflowAnchor = priorOverflowAnchor;
    suppression.release();
    // Released before the superseding navigation's scroll runs, so it writes
    // into a scroller this landing has fully let go of.
    scrollOwner.release();
  };

  // Both terminal paths below measure before they release, and `measureTarget` is
  // injected: a throw out of it (a view destroyed mid-settle) would otherwise
  // strand the suppression handle, the owner registration and the saved
  // `overflowAnchor` for the rest of the session, since nothing else releases
  // them and neither map decays. The `finally` makes the release unconditional
  // while keeping the happy-path order (release, then report); the throw
  // propagates from there, so the failure stays visible rather than swallowed.
  const land = (): void => {
    if (closed) return;
    closed = true;
    let delta: number;
    try {
      dispatch(); // final snap to the settled geometry before recording the result
      delta = finalDelta();
      // Persist so the container's remount-survival restore reproduces the landing
      // rather than the pre-landing position.
      if (lastTarget !== null) {
        writeLandingResult({
          docName,
          container,
          targetScrollTop: container.scrollTop,
          mode: landedMode,
        });
      }
    } finally {
      teardown();
    }
    mark('ok/landing/land', { grade, delta });
    onOutcome?.({ status: 'landed', delta });
  };

  const abandon = (): void => {
    if (closed) return;
    closed = true;
    const target = lastTarget ?? container.scrollTop;
    let delta: number;
    try {
      delta = finalDelta();
    } finally {
      teardown();
    }
    mark('ok/landing/abandoned', { grade, target, delta });
    onOutcome?.({ status: 'abandoned', delta });
  };

  const cancel = (reason: LandingCancelReason): void => {
    if (closed) return;
    closed = true;
    teardown();
    if (reason === 'mode-flip') onDiscardQueuedTarget?.();
    onOutcome?.({ status: 'cancelled', reason });
  };

  const armQuiet = (): void => {
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(land, quietMs);
  };

  function onUserInterrupt(): void {
    cancel('user-scroll');
  }

  function onSignal(): void {
    if (closed) return;
    const { measurable, moved } = dispatch();
    if (!measurable) return;
    // Restart the settle countdown only when we actually corrected: a signal that
    // finds us already in place lets the countdown run down to a land, while a
    // correction means layout is still moving and we wait for it to quiesce.
    if (moved || quietTimer === undefined) armQuiet();
  }

  // The holds are already acquired, and a throw before the handle is returned
  // leaves no one able to cancel — so the start is transactional: undo the
  // acquisition, then rethrow. The first `dispatch()` is the exposure (it is the
  // first call into the injected measurer), but the whole setup is covered so a
  // half-armed landing cannot keep them either.
  try {
    // Stage 1 — immediate synchronous dispatch. Even when the target is not yet
    // measurable, verification stays armed and the retained target survives until
    // a layout signal makes it measurable or the abandon window closes.
    if (dispatch().measurable) armQuiet();

    // Verification is event-driven. The content-visibility state change fires as
    // blocks engage/disengage on the target path, but never for JSX-component or
    // code-block targets (they opt out of content-visibility), so it is an
    // accelerator, not the gate; the content-column ResizeObserver and the trailing
    // quiet timer are the always-available terminal signals. Capture phase catches
    // the event on any descendant block.
    container.addEventListener('contentvisibilityautostatechange', onSignal, true);
    container.addEventListener('wheel', onUserInterrupt, { passive: true });
    container.addEventListener('touchstart', onUserInterrupt, { passive: true });
    if (typeof ResizeObserver !== 'undefined' && contentColumn) {
      resizeObserver = new ResizeObserver(onSignal);
      resizeObserver.observe(contentColumn);
    }
    // One post-first-frame retry covers a target that becomes measurable only after
    // the first layout yet fires no resize or content-visibility event (a small,
    // already-laid-out doc landing on a content-visibility-exempt block).
    raf = requestAnimationFrame(onSignal);

    abandonTimer = setTimeout(abandon, abandonAfterMs);
  } catch (err) {
    closed = true; // a listener that did get registered must not re-enter
    teardown();
    throw err;
  }

  return { cancel };
}
