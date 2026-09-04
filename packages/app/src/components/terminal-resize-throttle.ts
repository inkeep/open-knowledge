export interface ResizeThrottleTimers {
  setTimer(cb: () => void, ms: number): unknown;
  clearTimer(token: unknown): void;
}

export interface ResizeThrottle {
  request(): void;
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
