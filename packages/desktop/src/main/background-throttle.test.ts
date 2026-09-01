import { describe, expect, it, vi } from 'vitest';
import {
  applyBackgroundThrottle,
  type BackgroundThrottleSignal,
  computeBackgroundThrottlingAllowed,
  type ThrottleableWebContents,
} from './background-throttle.ts';

function makeFakeWebContents(opts: { destroyed?: boolean } = {}) {
  const setBackgroundThrottling = vi.fn<(allowed: boolean) => void>();
  const wc: ThrottleableWebContents = {
    isDestroyed: () => opts.destroyed ?? false,
    setBackgroundThrottling,
  };
  return { wc, setBackgroundThrottling };
}

describe('computeBackgroundThrottlingAllowed', () => {
  it('suppresses throttling only when enabled AND there is pending work', () => {
    expect(computeBackgroundThrottlingAllowed({ enabled: true, hasPendingWork: true })).toBe(false);
  });

  it('allows throttling (OS default) when enabled but no pending work', () => {
    expect(computeBackgroundThrottlingAllowed({ enabled: true, hasPendingWork: false })).toBe(true);
  });

  it('allows throttling (inert) when the kill-switch is OFF, even with pending work', () => {
    expect(computeBackgroundThrottlingAllowed({ enabled: false, hasPendingWork: true })).toBe(true);
  });

  it('allows throttling when the kill-switch is OFF and no pending work', () => {
    expect(computeBackgroundThrottlingAllowed({ enabled: false, hasPendingWork: false })).toBe(
      true,
    );
  });

  it('never leaves a window permanently unthrottled: no-pending-work always allows throttling', () => {
    for (const enabled of [true, false]) {
      const signal: BackgroundThrottleSignal = { enabled, hasPendingWork: false };
      expect(computeBackgroundThrottlingAllowed(signal)).toBe(true);
    }
  });
});

describe('applyBackgroundThrottle', () => {
  it('keeps timers alive (setBackgroundThrottling false) when work is pending and enabled', () => {
    const { wc, setBackgroundThrottling } = makeFakeWebContents();
    applyBackgroundThrottle(wc, { enabled: true, hasPendingWork: true });
    expect(setBackgroundThrottling).toHaveBeenCalledTimes(1);
    expect(setBackgroundThrottling).toHaveBeenCalledWith(false);
  });

  it('restores the OS default (setBackgroundThrottling true) when the window goes clean', () => {
    const { wc, setBackgroundThrottling } = makeFakeWebContents();
    applyBackgroundThrottle(wc, { enabled: true, hasPendingWork: true });
    applyBackgroundThrottle(wc, { enabled: true, hasPendingWork: false });
    expect(setBackgroundThrottling).toHaveBeenLastCalledWith(true);
  });

  it('is inert when the kill-switch is OFF: applies the OS default despite pending work', () => {
    const { wc, setBackgroundThrottling } = makeFakeWebContents();
    applyBackgroundThrottle(wc, { enabled: false, hasPendingWork: true });
    expect(setBackgroundThrottling).toHaveBeenCalledWith(true);
  });

  it('does not touch a destroyed webContents (shutdown race guard)', () => {
    const { wc, setBackgroundThrottling } = makeFakeWebContents({ destroyed: true });
    applyBackgroundThrottle(wc, { enabled: true, hasPendingWork: true });
    expect(setBackgroundThrottling).not.toHaveBeenCalled();
  });
});
