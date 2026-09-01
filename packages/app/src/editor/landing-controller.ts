import { mark } from '@/lib/perf';
import type { ResolveConfidence } from './mode-switch-position-resolver';
import {
  acquireScrollRestoreSuppression,
  registerLandingScrollOwner,
  writeLandingResult,
} from './scroll-restore-coordination';
import type { EditorModeValue } from './use-editor-mode';

export interface TargetMetrics {
  top: number;
  height: number;
}

export type LandingPlacement = 'center' | 'top';

type LandingIntent = 'toggle' | 'jump';

export type LandingCancelReason = 'user-scroll' | 'mode-flip' | 'superseded';

export type LandingOutcome =
  | { status: 'landed'; delta: number }
  | { status: 'cancelled'; reason: LandingCancelReason }
  | { status: 'abandoned'; delta: number };

export interface StartLandingParams {
  docName: string;
  container: HTMLElement;
  contentColumn?: HTMLElement | null;
  measureTarget: () => TargetMetrics | null;
  placement: LandingPlacement;
  intent: LandingIntent;
  grade: ResolveConfidence;
  landedMode: EditorModeValue;
  transition?: { from: EditorModeValue; to: EditorModeValue };
  toolbarOffset?: number;
  driftThresholdPx?: number;
  quietMs?: number;
  abandonAfterMs?: number;
  onOutcome?: (outcome: LandingOutcome) => void;
  onDiscardQueuedTarget?: () => void;
}

export interface LandingHandle {
  cancel(reason: LandingCancelReason): void;
}

const DEFAULT_TOOLBAR_OFFSET_PX = 56;
const DEFAULT_DRIFT_THRESHOLD_PX = 2;
const DEFAULT_SETTLE_QUIET_MS = 150;
const DEFAULT_ABANDON_MS = 2000;

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
    scrollOwner.release();
  };

  const land = (): void => {
    if (closed) return;
    closed = true;
    let delta: number;
    try {
      dispatch();
      delta = finalDelta();
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
    if (moved || quietTimer === undefined) armQuiet();
  }

  try {
    if (dispatch().measurable) armQuiet();

    container.addEventListener('contentvisibilityautostatechange', onSignal, true);
    container.addEventListener('wheel', onUserInterrupt, { passive: true });
    container.addEventListener('touchstart', onUserInterrupt, { passive: true });
    if (typeof ResizeObserver !== 'undefined' && contentColumn) {
      resizeObserver = new ResizeObserver(onSignal);
      resizeObserver.observe(contentColumn);
    }
    raf = requestAnimationFrame(onSignal);

    abandonTimer = setTimeout(abandon, abandonAfterMs);
  } catch (err) {
    closed = true;
    teardown();
    throw err;
  }

  return { cancel };
}
