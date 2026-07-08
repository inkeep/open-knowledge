import { describe, expect, test } from 'bun:test';
import { createResizeThrottle, type ResizeThrottleTimers } from './terminal-resize-throttle';

function makeHarness(intervalMs = 100) {
  const timers: Array<(() => void) | null> = [];
  const fakeTimers: ResizeThrottleTimers = {
    setTimer: (cb) => {
      timers.push(cb);
      return timers.length - 1;
    },
    clearTimer: (token) => {
      if (typeof token === 'number') timers[token] = null;
    },
  };
  let applies = 0;
  const throttle = createResizeThrottle(
    () => {
      applies += 1;
    },
    intervalMs,
    fakeTimers,
  );
  const runTimers = (): void => {
    const snapshot = timers.slice();
    for (let i = 0; i < snapshot.length; i += 1) {
      const cb = snapshot[i];
      if (cb) {
        timers[i] = null;
        cb();
      }
    }
  };
  const liveTimerCount = (): number => timers.filter((t) => t !== null).length;
  return {
    throttle,
    runTimers,
    liveTimerCount,
    get applies() {
      return applies;
    },
  };
}

describe('createResizeThrottle', () => {
  test('a lone request applies immediately (leading edge)', () => {
    const h = makeHarness();
    h.throttle.request();
    expect(h.applies).toBe(1);
  });

  test('requests during the interval coalesce into one trailing apply', () => {
    const h = makeHarness();
    h.throttle.request(); // leading
    h.throttle.request();
    h.throttle.request();
    expect(h.applies).toBe(1);
    h.runTimers();
    expect(h.applies).toBe(2); // one trailing apply for the coalesced burst
  });

  test('an interval that expires idle does not apply and closes the window', () => {
    const h = makeHarness();
    h.throttle.request();
    h.runTimers(); // no request landed inside the interval
    expect(h.applies).toBe(1);
    // Window closed — the next request is leading again.
    h.throttle.request();
    expect(h.applies).toBe(2);
  });

  test('a continuous stream applies once per interval, ending with a trailing settle', () => {
    const h = makeHarness();
    // Simulate a drag: request, tick, request, tick, ...
    h.throttle.request(); // leading apply
    h.throttle.request();
    h.runTimers(); // trailing apply, window renewed
    h.throttle.request();
    h.runTimers(); // trailing apply again
    expect(h.applies).toBe(3);
    // The renewed window with nothing pending expires silently.
    h.runTimers();
    expect(h.applies).toBe(3);
  });

  test('cancel drops the pending trailing apply and clears the timer', () => {
    const h = makeHarness();
    h.throttle.request();
    h.throttle.request(); // pending trailing
    h.throttle.cancel();
    h.runTimers();
    expect(h.applies).toBe(1);
    expect(h.liveTimerCount()).toBe(0);
  });
});
