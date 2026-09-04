import { useSyncExternalStore } from 'react';

let calendarDayNow = Date.now();
let midnightTimer: ReturnType<typeof setTimeout> | null = null;
const dayListeners = new Set<() => void>();

function msUntilNextLocalMidnight(from: number): number {
  const next = new Date(from);
  next.setHours(24, 0, 0, 0);
  return Math.max(next.getTime() - from, 1_000);
}

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

function getCalendarDayNow(): number {
  return calendarDayNow;
}

export function useCalendarDayNow(): number {
  return useSyncExternalStore(subscribeCalendarDay, getCalendarDayNow, getCalendarDayNow);
}
