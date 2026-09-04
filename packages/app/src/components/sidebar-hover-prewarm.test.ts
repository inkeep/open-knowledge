import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getCollector } from '../lib/perf/collector';
import { __peekPrewarmRecord, __resetPrewarmCorrelation } from './prewarm-correlation';
import {
  __resetSidebarHoverPrewarmForTests,
  cancelHoverPrewarm,
  scheduleHoverPrewarm,
} from './sidebar-hover-prewarm';

beforeEach(() => {
  __resetSidebarHoverPrewarmForTests();
  __resetPrewarmCorrelation();
  getCollector()?.reset();
});
afterEach(() => {
  __resetSidebarHoverPrewarmForTests();
  __resetPrewarmCorrelation();
});

describe('sidebar-hover-prewarm (review Major #7 + V2 FR12 Option G)', () => {
  test('hover → prewarm fires after 80ms intent window', async () => {
    const prewarm = vi.fn((docName: string): string | null => {
      expect(docName).toBe('doc-a');
      return null;
    });
    scheduleHoverPrewarm('doc-a', prewarm);
    expect(prewarm).not.toHaveBeenCalled();
    await wait(120);
    expect(prewarm).toHaveBeenCalledTimes(1);
  });

  test('quick mouse trail (dismiss before 80ms) fires no prewarm', async () => {
    const prewarm = vi.fn((): string | null => null);
    scheduleHoverPrewarm('doc-a', prewarm);
    await wait(30);
    cancelHoverPrewarm('doc-a');
    await wait(120);
    expect(prewarm).not.toHaveBeenCalled();
  });

  test('system docs are refused (__system__)', () => {
    const prewarm = vi.fn((): string | null => null);
    scheduleHoverPrewarm('__system__', prewarm);
    cancelHoverPrewarm('__system__');
    expect(prewarm).not.toHaveBeenCalled();
  });

  test('already-prewarmed doc does not re-fire', async () => {
    const prewarm = vi.fn(() => null);
    scheduleHoverPrewarm('doc-b', prewarm);
    await wait(120);
    expect(prewarm).toHaveBeenCalledTimes(1);
    scheduleHoverPrewarm('doc-b', prewarm);
    await wait(120);
    expect(prewarm).toHaveBeenCalledTimes(1);
  });

  test('successful prewarm emits ok/sidebar/prewarm-success and records the correlation seed', async () => {
    const prewarm = vi.fn(() => 'pool-event-x');
    scheduleHoverPrewarm('doc-c', prewarm);
    await wait(120);
    expect(prewarm).toHaveBeenCalledTimes(1);
    const successMark = getCollector()
      ?.marks.toArray()
      .find((m) => m.name === 'ok/sidebar/prewarm-success');
    expect(successMark?.properties?.docName).toBe('doc-c');
    expect(successMark?.properties?.poolEventId).toBe('pool-event-x');
    expect(typeof successMark?.properties?.t).toBe('number');
    expect(__peekPrewarmRecord('doc-c')?.poolEventId).toBe('pool-event-x');
  });

  test('null poolEventId from prewarm callback is treated as failure (no success mark)', async () => {
    const prewarm = vi.fn(() => null);
    scheduleHoverPrewarm('doc-d', prewarm);
    await wait(120);
    expect(prewarm).toHaveBeenCalledTimes(1);
    const successMark = getCollector()
      ?.marks.toArray()
      .find((m) => m.name === 'ok/sidebar/prewarm-success');
    expect(successMark).toBeUndefined();
    expect(__peekPrewarmRecord('doc-d')).toBeUndefined();
  });

  test('throwing prewarm callback (synchronous error from pool ctor / WS / etc.) emits ok/sidebar/prewarm-failed and does not propagate to window.onerror', async () => {
    const failureMessage = 'synthetic ProviderPool ctor failure';
    const prewarm = vi.fn(() => {
      throw new Error(failureMessage);
    });
    let uncaughtCount = 0;
    const onError = () => {
      uncaughtCount += 1;
    };
    process.on('uncaughtException', onError);
    process.on('unhandledRejection', onError);
    try {
      scheduleHoverPrewarm('doc-throw', prewarm);
      await wait(120);
      expect(prewarm).toHaveBeenCalledTimes(1);
      const failMark = getCollector()
        ?.marks.toArray()
        .find((m) => m.name === 'ok/sidebar/prewarm-failed');
      expect(failMark?.properties?.docName).toBe('doc-throw');
      expect(failMark?.properties?.message).toBe(failureMessage);
      const successMark = getCollector()
        ?.marks.toArray()
        .find(
          (m) => m.name === 'ok/sidebar/prewarm-success' && m.properties?.docName === 'doc-throw',
        );
      expect(successMark).toBeUndefined();
      expect(__peekPrewarmRecord('doc-throw')).toBeUndefined();
      expect(uncaughtCount).toBe(0);
    } finally {
      process.off('uncaughtException', onError);
      process.off('unhandledRejection', onError);
    }
  });
});
