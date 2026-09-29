import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

async function loadClock() {
  vi.resetModules();
  return await import('@/lib/acp/activity-clock');
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useActivityClock', () => {
  test('one timer serves every reader and stops when the last one leaves', async () => {
    const { useActivityClock } = await loadClock();
    const first = renderHook(() => useActivityClock());
    const second = renderHook(() => useActivityClock());
    expect(vi.getTimerCount()).toBe(1);

    first.unmount();
    expect(vi.getTimerCount()).toBe(1);

    second.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('a reader keeps ticking after another one leaves', async () => {
    vi.setSystemTime(1_000_000);
    const { useActivityClock } = await loadClock();
    const first = renderHook(() => useActivityClock());
    const second = renderHook(() => useActivityClock());

    first.unmount();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(second.result.current).toBe(1_030_000);
  });

  test('a reader arriving after the last one left reads the current time', async () => {
    vi.setSystemTime(1_000_000);
    const { useActivityClock } = await loadClock();
    renderHook(() => useActivityClock()).unmount();

    vi.setSystemTime(5_000_000);
    const reopened = renderHook(() => useActivityClock());

    expect(reopened.result.current).toBe(5_000_000);
  });
});
