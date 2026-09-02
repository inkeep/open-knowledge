import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

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
    vi.setSystemTime(new Date(2026, 2, 3, 23, 40));
    const { useCalendarDayNow } = await loadStore();

    vi.setSystemTime(new Date(2026, 2, 4, 10, 3));
    const { result } = renderHook(() => useCalendarDayNow());

    expect(dayOf(result.current)).toBe(4);
  });

  test('the timer survives one of two stamps unmounting', async () => {
    vi.setSystemTime(new Date(2026, 2, 3, 23, 59, 30));
    const { useCalendarDayNow } = await loadStore();
    const first = renderHook(() => useCalendarDayNow());
    const second = renderHook(() => useCalendarDayNow());

    first.unmount();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(dayOf(second.result.current)).toBe(4);
  });

  test('a stamp resubscribing after the last one left is current again', async () => {
    vi.setSystemTime(new Date(2026, 2, 3, 20, 0));
    const { useCalendarDayNow } = await loadStore();
    const only = renderHook(() => useCalendarDayNow());
    only.unmount();

    vi.setSystemTime(new Date(2026, 2, 4, 9, 15));
    const reopened = renderHook(() => useCalendarDayNow());

    expect(dayOf(reopened.result.current)).toBe(4);
  });
});
