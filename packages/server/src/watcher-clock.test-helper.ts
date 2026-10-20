import type { WatcherClock, WatcherTimer } from './watcher-clock.ts';

interface ScheduledTimer extends WatcherTimer {
  due: number;
  interval: number | null;
  callback: () => void;
}

export interface ManualClock extends WatcherClock {
  advance(ms: number): void;
  pendingTimers(): number;
}

export function createManualClock(startMs = 1_700_000_000_000): ManualClock {
  let current = startMs;
  const timers: ScheduledTimer[] = [];

  const schedule = (callback: () => void, delayMs: number, interval: number | null) => {
    const timer: ScheduledTimer = {
      due: current + Math.max(0, delayMs),
      interval,
      callback,
      unref: () => timer,
    };
    timers.push(timer);
    return timer;
  };

  const cancel = (timer: WatcherTimer | null | undefined) => {
    if (!timer) return;
    const index = timers.indexOf(timer as ScheduledTimer);
    if (index >= 0) timers.splice(index, 1);
  };

  return {
    now: () => current,
    setTimeout: (callback, delayMs) => schedule(callback, delayMs, null),
    clearTimeout: cancel,
    setInterval: (callback, intervalMs) => schedule(callback, intervalMs, Math.max(1, intervalMs)),
    clearInterval: cancel,
    advance(ms) {
      const target = current + ms;
      for (;;) {
        const due = timers.filter((timer) => timer.due <= target).sort((a, b) => a.due - b.due);
        const next = due[0];
        if (!next) break;
        current = Math.max(current, next.due);
        if (next.interval === null) {
          timers.splice(timers.indexOf(next), 1);
        } else {
          next.due = current + next.interval;
        }
        next.callback();
      }
      current = target;
    },
    pendingTimers: () => timers.length,
  };
}
