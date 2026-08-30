/**
 * A clock that advances at local midnight, for stamps whose only question of
 * `now` is which calendar day it is.
 *
 * Capturing `now` once per mount would be wrong for a transcript: nothing
 * unmounts a bubble — every open thread stays mounted, the scroller doesn't
 * virtualize, and a hidden `<Activity>` keeps its subtree — so in a desktop app
 * left open overnight a turn sent 11:50 PM Monday would still render a bare
 * "11:50 PM" on Tuesday, indistinguishable from today.
 *
 * Module-scope store + `useSyncExternalStore`, the package's established shape,
 * so one timer serves every stamp on screen rather than one per bubble.
 */

import { useSyncExternalStore } from 'react';

let calendarDayNow = Date.now();
let midnightTimer: ReturnType<typeof setTimeout> | null = null;
const dayListeners = new Set<() => void>();

function msUntilNextLocalMidnight(from: number): number {
  const next = new Date(from);
  next.setHours(24, 0, 0, 0);
  // Floored because the re-arm reads the clock again after the timer fires, and
  // a timer that comes back a hair early leaves `Date.now()` still just short of
  // midnight. The unfloored delay would then be a fraction of a millisecond and
  // the timer would re-arm in a tight loop until the clock caught up.
  return Math.max(next.getTime() - from, 1_000);
}

/**
 * Reads the clock on every arm, not just on the midnight tick.
 *
 * The timer is armed when the first listener subscribes and cleared when the
 * last one leaves, so the value would otherwise be whatever it was when this
 * module was evaluated (a lazy chunk loaded long before the first stamp mounts)
 * or when the last stamp unmounted. Both go stale across a day boundary, and a
 * `now` behind the message it is measuring reads worse than a mount-time
 * capture: a turn sent seconds ago would render with a date on it.
 *
 * Safe to write during `subscribe` — React re-reads the snapshot right after
 * the subscribe effect and re-renders if it moved.
 */
function armMidnightTimer(): void {
  calendarDayNow = Date.now();
  midnightTimer = setTimeout(() => {
    armMidnightTimer();
    for (const listener of dayListeners) listener();
  }, msUntilNextLocalMidnight(Date.now()));
}

function subscribeCalendarDay(listener: () => void): () => void {
  dayListeners.add(listener);
  if (midnightTimer === null) armMidnightTimer();
  return () => {
    dayListeners.delete(listener);
    if (dayListeners.size === 0 && midnightTimer !== null) {
      clearTimeout(midnightTimer);
      midnightTimer = null;
    }
  };
}

/** Stable between midnights, so React can memoize on it. */
function getCalendarDayNow(): number {
  return calendarDayNow;
}

/** The `now` a calendar-granularity stamp should format against. */
export function useCalendarDayNow(): number {
  return useSyncExternalStore(subscribeCalendarDay, getCalendarDayNow, getCalendarDayNow);
}
