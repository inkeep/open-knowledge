/**
 * The clock behind every sent-message stamp. `formatSentAt` is pure and tested
 * on its own; what needed pinning is the `now` it is handed, because the store
 * arms its timer at the subscribe edge and the value it serves before the first
 * midnight tick comes from whenever the module happened to load.
 */

import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/** A fresh module per test: the store is module-scope by design, so the only
 *  honest way to exercise a cold load is to load it cold. */
async function loadStore() {
  vi.resetModules();
  return await import('@/components/acp/calendar-day-store');
}

const dayOf = (ms: number) => new Date(ms).getDate();

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useCalendarDayNow', () => {
  test('a stamp mounting the next morning reads today, not whenever the chunk loaded', async () => {
    // The lazy thread chunk loads when the panel opens; the first stamp mounts
    // only once a thread has a user turn, which can be the next day.
    vi.setSystemTime(new Date(2026, 2, 3, 23, 40));
    const { useCalendarDayNow } = await loadStore();

    vi.setSystemTime(new Date(2026, 2, 4, 10, 3));
    const { result } = renderHook(() => useCalendarDayNow());

    // Serving last night here would date-stamp a message sent seconds ago,
    // which reads worse than the mount-time capture this store replaced.
    expect(dayOf(result.current)).toBe(4);
  });

  test('the timer survives one of two stamps unmounting', async () => {
    vi.setSystemTime(new Date(2026, 2, 3, 23, 59, 30));
    const { useCalendarDayNow } = await loadStore();
    const first = renderHook(() => useCalendarDayNow());
    const second = renderHook(() => useCalendarDayNow());

    first.unmount();
    // Past midnight: the surviving stamp must still be told the day turned.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(dayOf(second.result.current)).toBe(4);
  });

  test('a stamp resubscribing after the last one left is current again', async () => {
    vi.setSystemTime(new Date(2026, 2, 3, 20, 0));
    const { useCalendarDayNow } = await loadStore();
    const only = renderHook(() => useCalendarDayNow());
    // Closing the last thread with user turns drains the listeners and clears
    // the timer, so nothing advances the value while nothing is watching.
    only.unmount();

    vi.setSystemTime(new Date(2026, 2, 4, 9, 15));
    const reopened = renderHook(() => useCalendarDayNow());

    expect(dayOf(reopened.result.current)).toBe(4);
  });
});
