import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
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
    const prewarm = mock((docName: string): string | null => {
      expect(docName).toBe('doc-a');
      return null;
    });
    scheduleHoverPrewarm('doc-a', prewarm);
    expect(prewarm).not.toHaveBeenCalled();
    await wait(120);
    expect(prewarm).toHaveBeenCalledTimes(1);
  });

  test('quick mouse trail (dismiss before 80ms) fires no prewarm', async () => {
    const prewarm = mock((): string | null => null);
    scheduleHoverPrewarm('doc-a', prewarm);
    // Mouse leaves after 30ms, well before the 80ms intent threshold.
    await wait(30);
    cancelHoverPrewarm('doc-a');
    await wait(120);
    expect(prewarm).not.toHaveBeenCalled();
  });

  test('system docs are refused (__system__)', () => {
    const prewarm = mock((): string | null => null);
    scheduleHoverPrewarm('__system__', prewarm);
    // No timer scheduled — cancel is a no-op.
    cancelHoverPrewarm('__system__');
    // Nothing fires even at the timer horizon.
    expect(prewarm).not.toHaveBeenCalled();
  });

  test('already-prewarmed doc does not re-fire', async () => {
    const prewarm = mock(() => null);
    scheduleHoverPrewarm('doc-b', prewarm);
    await wait(120);
    expect(prewarm).toHaveBeenCalledTimes(1);
    // Second hover on the same doc — no re-fire.
    scheduleHoverPrewarm('doc-b', prewarm);
    await wait(120);
    expect(prewarm).toHaveBeenCalledTimes(1);
  });

  test('successful prewarm emits ok/sidebar/prewarm-success and records the correlation seed', async () => {
    const prewarm = mock(() => 'pool-event-x');
    scheduleHoverPrewarm('doc-c', prewarm);
    await wait(120);
    expect(prewarm).toHaveBeenCalledTimes(1);
    const successMark = getCollector()
      ?.marks.toArray()
      .find((m) => m.name === 'ok/sidebar/prewarm-success');
    expect(successMark?.properties?.docName).toBe('doc-c');
    expect(successMark?.properties?.poolEventId).toBe('pool-event-x');
    expect(typeof successMark?.properties?.t).toBe('number');
    // Correlation seed recorded for later click-side join.
    expect(__peekPrewarmRecord('doc-c')?.poolEventId).toBe('pool-event-x');
  });

  test('null poolEventId from prewarm callback is treated as failure (no success mark)', async () => {
    const prewarm = mock(() => null);
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
    // The prewarm callback is a real R7 trust boundary — provided by
    // ProviderPool; HocuspocusProvider construction or WebSocket creation
    // can throw synchronously. The catch block in scheduleHoverPrewarm's
    // setTimeout body emits a `prewarm-failed` mark and swallows the
    // throw so a sidebar hover never takes down the page (no React
    // boundary catches setTimeout/drainQueue exceptions). Without this
    // test, a future removal or narrowing of that catch would silently
    // regress: production hovers would surface as `window.onerror`
    // notifications. Pattern B test — real failure-inducing input
    // through the public interface.
    const failureMessage = 'synthetic ProviderPool ctor failure';
    const prewarm = mock(() => {
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
      // No success mark + no correlation seed for a failed prewarm.
      const successMark = getCollector()
        ?.marks.toArray()
        .find(
          (m) => m.name === 'ok/sidebar/prewarm-success' && m.properties?.docName === 'doc-throw',
        );
      expect(successMark).toBeUndefined();
      expect(__peekPrewarmRecord('doc-throw')).toBeUndefined();
      // Verify the catch swallowed: no uncaught exception escaped.
      expect(uncaughtCount).toBe(0);
    } finally {
      process.off('uncaughtException', onError);
      process.off('unhandledRejection', onError);
    }
  });
});
