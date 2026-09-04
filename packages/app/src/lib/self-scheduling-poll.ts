export type PollOutcome = 'ok' | 'error';

export interface SelfSchedulingPollOptions {
  poll: (signal: AbortSignal) => Promise<PollOutcome>;
  baseMs: number;
  maxBackoffMs: number;
  isPaused: () => boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface SelfSchedulingPoll {
  start(): void;
  resume(): void;
  stop(): void;
}

export function createSelfSchedulingPoll(opts: SelfSchedulingPollOptions): SelfSchedulingPoll {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let stopped = false;
  let started = false;
  let timer: unknown = null;
  let controller: AbortController | null = null;
  let backoffMs = opts.baseMs;
  let parked = false;

  const scheduleNext = (delayMs: number): void => {
    if (stopped) return;
    if (opts.isPaused()) {
      parked = true;
      return;
    }
    timer = setTimer(tick, delayMs);
  };

  async function tick(): Promise<void> {
    timer = null;
    parked = false;
    if (stopped) return;
    if (opts.isPaused()) {
      parked = true;
      return;
    }
    controller = new AbortController();
    const signal = controller.signal;
    try {
      const outcome = await opts.poll(signal);
      if (stopped) return;
      if (outcome === 'ok') {
        backoffMs = opts.baseMs;
        scheduleNext(opts.baseMs);
      } else {
        backoffMs = Math.min(backoffMs * 2, opts.maxBackoffMs);
        scheduleNext(backoffMs);
      }
    } catch {
      if (stopped || signal.aborted) return;
      backoffMs = Math.min(backoffMs * 2, opts.maxBackoffMs);
      scheduleNext(backoffMs);
    }
  }

  return {
    start() {
      if (stopped || started) return;
      started = true;
      void tick();
    },
    resume() {
      if (stopped) return;
      if (!opts.isPaused() && parked && timer === null) {
        parked = false;
        void tick();
      }
    },
    stop() {
      stopped = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      controller?.abort();
    },
  };
}
