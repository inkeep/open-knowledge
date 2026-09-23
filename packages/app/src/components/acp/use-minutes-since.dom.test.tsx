import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useMinutesSince } from './use-minutes-since';

describe('useMinutesSince', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('a stall that begins after mount reads its true age on the very first render', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-23T10:00:00Z'));
    const { result, rerender } = renderHook((since: number | undefined) => useMinutesSince(since), {
      initialProps: undefined as number | undefined,
    });
    expect(result.current).toBe(0);

    act(() => {
      vi.setSystemTime(new Date('2026-09-23T10:10:00Z'));
    });
    rerender(Date.now() - 3 * 60_000);
    expect(result.current).toBe(3);
  });

  test('the count keeps up with the clock while the stall lasts', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-23T10:00:00Z'));
    const since = Date.now() - 60_000;
    const { result } = renderHook(() => useMinutesSince(since));
    expect(result.current).toBe(1);

    act(() => {
      vi.advanceTimersByTime(2 * 60_000);
    });
    expect(result.current).toBe(3);
  });
});
