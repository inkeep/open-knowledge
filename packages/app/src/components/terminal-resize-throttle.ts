/**
 * Leading+trailing throttle for the terminal's PTY resize.
 *
 * A section-drag with the terminal docked resizes its container on every
 * pointer frame. The xterm fit itself must run per event — stepping it makes
 * the grid visibly jump (flicker) during drags, and it is cheap per event
 * since FitAddon only reflows when a cell boundary is actually crossed. But
 * forwarding every step to the PTY SIGWINCHes the running program into a
 * full-screen repaint whose output floods straight back through IPC + render
 * — at pointer frequency that is the drag lag users hit with a terminal open.
 *
 * Leading+trailing keeps the first resize instant (a lone resize — dock
 * open, window resize — reaches the shell immediately) while a continuous
 * stream applies at most once per interval, with one trailing call so the
 * PTY always settles at the final size.
 */

export interface ResizeThrottleTimers {
  /** `setTimeout` in production; captured in tests. */
  setTimer(cb: () => void, ms: number): unknown;
  /** `clearTimeout` in production. */
  clearTimer(token: unknown): void;
}

export interface ResizeThrottle {
  /** Request a resize apply. Leading call applies immediately; calls landing inside
   *  the interval coalesce into one trailing apply at its end. */
  request(): void;
  /** Drop any pending trailing apply and cancel the interval timer. */
  cancel(): void;
}

const defaultTimers: ResizeThrottleTimers = {
  setTimer: (cb, ms) => setTimeout(cb, ms),
  clearTimer: (token) => clearTimeout(token as ReturnType<typeof setTimeout>),
};

export function createResizeThrottle(
  apply: () => void,
  intervalMs: number,
  timers: ResizeThrottleTimers = defaultTimers,
): ResizeThrottle {
  let windowToken: unknown = null;
  let trailingPending = false;

  function openWindow(): void {
    windowToken = timers.setTimer(() => {
      windowToken = null;
      if (trailingPending) {
        trailingPending = false;
        apply();
        // The trailing apply starts a fresh interval so a continuous stream
        // (an active drag) stays bounded at one apply per interval.
        openWindow();
      }
    }, intervalMs);
  }

  return {
    request(): void {
      if (windowToken !== null) {
        trailingPending = true;
        return;
      }
      apply();
      openWindow();
    },
    cancel(): void {
      if (windowToken !== null) {
        timers.clearTimer(windowToken);
        windowToken = null;
      }
      trailingPending = false;
    },
  };
}
