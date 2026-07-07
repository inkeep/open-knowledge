/**
 * Self-scheduling poll loop.
 *
 * The next poll is armed ONLY after the previous one settles, so a slow request
 * can never stack into a self-inflicted load storm — there is at most one poll
 * in flight at any time. The loop pauses while `isPaused()` is true (e.g. a
 * hidden browser tab → zero requests) and resumes via `resume()`. Errors back
 * off exponentially up to `maxBackoffMs`; a success resets the cadence to
 * `baseMs`.
 *
 * Pure and timer-injectable so the scheduling contract is unit-testable without
 * a DOM or real timers. The browser wiring (fetch, setState, visibilitychange)
 * lives in the caller's `poll` callback.
 */
export type PollOutcome = 'ok' | 'error';

export interface SelfSchedulingPollOptions {
  /**
   * Run one poll. Resolve `'ok'` to reset the cadence or `'error'` to back off.
   * Receives an AbortSignal aborted on `stop()`; a rejection whose signal is
   * aborted is treated as a cancellation (no reschedule), any other rejection
   * is treated as `'error'`.
   */
  poll: (signal: AbortSignal) => Promise<PollOutcome>;
  baseMs: number;
  maxBackoffMs: number;
  /** True when polling should pause (checked before arming each poll). */
  isPaused: () => boolean;
  /** Injectable timer (defaults to setTimeout/clearTimeout) for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface SelfSchedulingPoll {
  /** Run the first poll and begin the loop. Idempotent: the first call starts the
   *  loop; later calls (while running or after stop()) are no-ops. */
  start(): void;
  /** Resume a loop parked by `isPaused` (call from a visibility/online handler). */
  resume(): void;
  /** Stop the loop, clear any pending timer, and abort an in-flight poll. */
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
  // Set when an arm is declined because `isPaused()` was true; `resume()` only
  // restarts a loop in this state, so it never double-fires.
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
      // A rejection from the aborted in-flight poll (stop / doc-nav) must not
      // reschedule; any other rejection is an error → back off.
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
      // Resume only a parked loop with no timer pending — avoids double-firing.
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
