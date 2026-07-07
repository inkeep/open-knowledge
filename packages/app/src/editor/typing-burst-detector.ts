/**
 * Per-burst typing detector.
 *
 * Replaces per-keystroke marks (cardinality explosion) with exactly one
 * `ok/typing/burst-settled` mark per typing burst — emitted after
 * `BURST_DEBOUNCE_MS` of user-input quiescence. The wire site's job is
 * to apply the origin gate (drop programmatic / sync transactions) and
 * call `recordUserInput()` on each user-input transaction; this module
 * accumulates state and emits the settle event.
 *
 * Tree-shake: wire sites in `TiptapEditor.tsx` and `SourceEditor.tsx`
 * MUST guard `if (!import.meta.env.PROD)` so the entire module + its
 * callers tree-shake out of production bundles. The bundle-check
 * assertion greps prod chunks for the sentinel below to detect
 * tree-shake regression.
 *
 * Why per-burst (not per-keystroke): keystrokes fire at IKI ≈ 100-500
 * ms apart. CHI 2018 study reports IKI 239 ms median. A 400 ms debounce
 * (BURST_DEBOUNCE_MS default) sits above the median IKI but below the
 * semantic-pause threshold, capturing one mark per uninterrupted typing
 * stretch.
 */

import { mark } from '@/lib/perf';
import { readNumericOverride } from '@/lib/perf/env-override';

/**
 * Sentinel string — bundle-check greps prod chunks and fails the build
 * if it appears, proving the typing detector tree-shook. Update when
 * changing the burst contract so old prod chunks remain detectable as
 * regressions.
 */
export const TYPING_BURST_DETECTOR_SENTINEL = 'ok-typing-burst-detector-v1' as const;

export type EditorMode = 'WYSIWYG' | 'Source';

export interface AttachOpts {
  mode: EditorMode;
  docName: string;
  mountId: string;
}

export interface TypingBurstSampler {
  /**
   * Record a single user-input transaction. The wire-site MUST have
   * filtered programmatic origins (Y.js sync, paired writes,
   * file-watcher) before calling — only user-input transactions reach
   * here. Schedules a debounce timer; emits the burst-settled mark
   * after `BURST_DEBOUNCE_MS` of quiescence.
   *
   * @param durationMs reserved for future wire-site instrumentation —
   *   the wall-clock cost of dispatching this single transaction (PM
   *   updateState + render). Currently no wire site can supply this
   *   non-zero, so the corresponding payload fields were trimmed; the
   *   parameter stays in the signature for forward compatibility (the
   *   measurement need is real, the wire-site hookup is future work).
   *   Pass 0 from current call sites.
   * @param charsDelta net character count change from the transaction
   *   (positive for inserts, negative for deletes).
   */
  recordUserInput(durationMs: number, charsDelta: number): void;
  /** Tear down the detector — clear pending debounce, remove state. */
  detach(): void;
}

interface BurstState {
  pendingBurstStart: number | null;
  charsTyped: number;
  transactions: number;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

function newBurstState(): BurstState {
  return {
    pendingBurstStart: null,
    charsTyped: 0,
    transactions: 0,
    debounceTimer: null,
  };
}

function emitSettled(opts: AttachOpts, state: BurstState): void {
  const burstStart = state.pendingBurstStart;
  if (burstStart === null || state.charsTyped === 0) return;
  const burstDurationMs = Math.max(0, performance.now() - burstStart);
  mark('ok/typing/burst-settled', {
    docName: opts.docName,
    mountId: opts.mountId,
    mode: opts.mode,
    charsTyped: state.charsTyped,
    transactions: state.transactions,
    burstDurationMs,
  });
  // Reuse `burst-settled` as the histogram name with a `.totalMs`
  // suffix for the Histogram. Two emissions per settle — the
  // mark for DevTools track integration, the histogram for in-process
  // percentile aggregation.
  mark.histogram(
    'ok/typing/burst-total-ms',
    { mode: opts.mode, docName: opts.docName },
    burstDurationMs,
  );
}

/**
 * Attach a typing burst detector. Returns a sampler the wire-site
 * uses to record user-input transactions, plus a `detach()` function
 * for cleanup. Multiple detectors per EditorView (e.g. one per pane)
 * are independent — state is closed over each instance.
 */
export function attachTypingBurstDetector(opts: AttachOpts): TypingBurstSampler {
  const debounceMs = readNumericOverride('BURST_DEBOUNCE_MS', 400);
  const state = newBurstState();

  function scheduleSettle(): void {
    if (state.debounceTimer !== null) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      emitSettled(opts, state);
      Object.assign(state, newBurstState());
    }, debounceMs);
  }

  return {
    recordUserInput(_durationMs, charsDelta) {
      // _durationMs is reserved for future wire-site instrumentation —
      // current call sites pass 0; the corresponding payload fields
      // (longestTaskMs / cumulativePmUpdateStateMs / cumulativeRenderMs)
      // were trimmed to avoid shipping always-zero telemetry. See the
      // recordUserInput JSDoc above for re-introduction guidance.
      if (state.pendingBurstStart === null) state.pendingBurstStart = performance.now();
      state.charsTyped += Math.abs(charsDelta);
      state.transactions += 1;
      scheduleSettle();
    },
    detach() {
      // Flush any in-flight burst before tearing down: if the user typed
      // and then immediately closed the doc / unmounted the editor, the
      // debounce timer hasn't fired yet — emitting the partial settle mark
      // here keeps short bursts visible in traces. emitSettled is a no-op
      // when no burst is pending (charsTyped===0 || pendingBurstStart===null).
      if (state.debounceTimer !== null) clearTimeout(state.debounceTimer);
      emitSettled(opts, state);
      Object.assign(state, newBurstState());
    },
  };
}
