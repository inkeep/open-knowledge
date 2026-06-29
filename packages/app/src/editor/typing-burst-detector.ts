
import { mark } from '@/lib/perf';
import { readNumericOverride } from '@/lib/perf/env-override';

export const TYPING_BURST_DETECTOR_SENTINEL = 'ok-typing-burst-detector-v1' as const;

export type EditorMode = 'WYSIWYG' | 'Source';

export interface AttachOpts {
  mode: EditorMode;
  docName: string;
  mountId: string;
}

export interface TypingBurstSampler {
  recordUserInput(durationMs: number, charsDelta: number): void;
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
  mark.histogram(
    'ok/typing/burst-total-ms',
    { mode: opts.mode, docName: opts.docName },
    burstDurationMs,
  );
}

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
      if (state.pendingBurstStart === null) state.pendingBurstStart = performance.now();
      state.charsTyped += Math.abs(charsDelta);
      state.transactions += 1;
      scheduleSettle();
    },
    detach() {
      if (state.debounceTimer !== null) clearTimeout(state.debounceTimer);
      emitSettled(opts, state);
      Object.assign(state, newBurstState());
    },
  };
}
