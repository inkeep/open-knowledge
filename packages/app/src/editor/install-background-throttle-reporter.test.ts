import { describe, expect, it } from 'vitest';
import { installBackgroundThrottleReporter } from './install-background-throttle-reporter';

function makeFakePool(initial: boolean) {
  let pending = initial;
  const listeners = new Set<() => void>();
  return {
    setPending(next: boolean) {
      pending = next;
      for (const cb of listeners) cb();
    },
    hasAnyUnsyncedWork: () => pending,
    addUnsyncedWorkListener: (cb: () => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    listenerCount: () => listeners.size,
  };
}

describe('installBackgroundThrottleReporter', () => {
  it('seeds main with the current state on install', () => {
    const pool = makeFakePool(false);
    const reports: { hasPendingWork: boolean; enabled: boolean }[] = [];
    installBackgroundThrottleReporter({
      enabled: true,
      hasAnyUnsyncedWork: pool.hasAnyUnsyncedWork,
      addUnsyncedWorkListener: pool.addUnsyncedWorkListener,
      report: (s) => reports.push(s),
    });
    expect(reports).toEqual([{ hasPendingWork: false, enabled: true }]);
  });

  it('reports the true↔false transitions and carries the kill-switch', () => {
    const pool = makeFakePool(false);
    const reports: { hasPendingWork: boolean; enabled: boolean }[] = [];
    installBackgroundThrottleReporter({
      enabled: true,
      hasAnyUnsyncedWork: pool.hasAnyUnsyncedWork,
      addUnsyncedWorkListener: pool.addUnsyncedWorkListener,
      report: (s) => reports.push(s),
    });
    pool.setPending(true);
    pool.setPending(false);
    expect(reports).toEqual([
      { hasPendingWork: false, enabled: true },
      { hasPendingWork: true, enabled: true },
      { hasPendingWork: false, enabled: true },
    ]);
  });

  it('dedupes: a burst that does not cross the edge reports once', () => {
    const pool = makeFakePool(false);
    const reports: { hasPendingWork: boolean; enabled: boolean }[] = [];
    installBackgroundThrottleReporter({
      enabled: true,
      hasAnyUnsyncedWork: pool.hasAnyUnsyncedWork,
      addUnsyncedWorkListener: pool.addUnsyncedWorkListener,
      report: (s) => reports.push(s),
    });
    pool.setPending(true);
    pool.setPending(true);
    pool.setPending(true);
    expect(reports.filter((r) => r.hasPendingWork)).toHaveLength(1);
  });

  it('forwards the disabled kill-switch so main resolves the OS default', () => {
    const pool = makeFakePool(true);
    const reports: { hasPendingWork: boolean; enabled: boolean }[] = [];
    installBackgroundThrottleReporter({
      enabled: false,
      hasAnyUnsyncedWork: pool.hasAnyUnsyncedWork,
      addUnsyncedWorkListener: pool.addUnsyncedWorkListener,
      report: (s) => reports.push(s),
    });
    expect(reports).toEqual([{ hasPendingWork: true, enabled: false }]);
  });

  it('stops reporting after unsubscribe', () => {
    const pool = makeFakePool(false);
    const reports: { hasPendingWork: boolean; enabled: boolean }[] = [];
    const stop = installBackgroundThrottleReporter({
      enabled: true,
      hasAnyUnsyncedWork: pool.hasAnyUnsyncedWork,
      addUnsyncedWorkListener: pool.addUnsyncedWorkListener,
      report: (s) => reports.push(s),
    });
    stop();
    expect(pool.listenerCount()).toBe(0);
    pool.setPending(true);
    expect(reports).toHaveLength(1);
  });
});
