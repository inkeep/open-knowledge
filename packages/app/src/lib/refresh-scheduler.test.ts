import { describe, expect, test } from 'bun:test';
import { setImmediate } from 'node:timers/promises';
import { createRefreshScheduler } from './refresh-scheduler';

describe('createRefreshScheduler', () => {
  test('starts a refresh immediately when idle', async () => {
    let calls = 0;
    const scheduler = createRefreshScheduler(() => {
      calls += 1;
    });

    scheduler.request();
    expect(calls).toBe(1);
  });

  test('coalesces burst requests while a refresh is in flight', async () => {
    const first = Promise.withResolvers<void>();
    const started: number[] = [];
    const scheduler = createRefreshScheduler(() => {
      started.push(started.length + 1);
      return started.length === 1 ? first.promise : undefined;
    });

    scheduler.request();
    scheduler.request();
    scheduler.request();
    expect(started).toEqual([1]);

    first.resolve();
    await setImmediate();

    expect(started).toEqual([1, 2]);
  });

  test('runs at most one trailing refresh for many in-flight requests', async () => {
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    let calls = 0;
    const scheduler = createRefreshScheduler(() => {
      calls += 1;
      if (calls === 1) return first.promise;
      if (calls === 2) return second.promise;
    });

    scheduler.request();
    scheduler.request();
    scheduler.request();
    first.resolve();
    await setImmediate();
    scheduler.request();
    scheduler.request();
    expect(calls).toBe(2);

    second.resolve();
    await setImmediate();

    expect(calls).toBe(3);
  });

  test('dispose prevents future and trailing refreshes', async () => {
    const first = Promise.withResolvers<void>();
    let calls = 0;
    const scheduler = createRefreshScheduler(() => {
      calls += 1;
      return first.promise;
    });

    scheduler.request();
    scheduler.request();
    scheduler.dispose();
    first.resolve();
    scheduler.request();

    expect(calls).toBe(1);
  });

  test('a request superseding an in-flight run invokes cancel once and still coalesces', async () => {
    const first = Promise.withResolvers<void>();
    let calls = 0;
    let cancels = 0;
    const scheduler = createRefreshScheduler(
      () => {
        calls += 1;
        return calls === 1 ? first.promise : undefined;
      },
      () => {
        cancels += 1;
      },
    );

    scheduler.request(); // run 1 starts, hangs on `first`
    expect(calls).toBe(1);
    scheduler.request(); // supersede → cancel fires, run coalesced to pending
    expect(cancels).toBe(1);
    expect(calls).toBe(1);

    first.resolve();
    await setImmediate();

    // Exactly one trailing re-run, and no further cancel for the idle re-run.
    expect(calls).toBe(2);
    expect(cancels).toBe(1);
  });

  test('every superseding request fires cancel but they still coalesce to one re-run', async () => {
    const first = Promise.withResolvers<void>();
    let calls = 0;
    let cancels = 0;
    const scheduler = createRefreshScheduler(
      () => {
        calls += 1;
        return calls === 1 ? first.promise : undefined;
      },
      () => {
        cancels += 1;
      },
    );

    scheduler.request();
    scheduler.request();
    scheduler.request();
    scheduler.request();
    expect(calls).toBe(1);
    expect(cancels).toBe(3); // three supersedes against the one in-flight run

    first.resolve();
    await setImmediate();

    expect(calls).toBe(2); // single trailing re-run despite three supersedes
  });

  test('dispose invokes cancel to abort an in-flight fetch', async () => {
    const first = Promise.withResolvers<void>();
    let cancels = 0;
    const scheduler = createRefreshScheduler(
      () => first.promise,
      () => {
        cancels += 1;
      },
    );

    scheduler.request();
    scheduler.dispose();
    expect(cancels).toBe(1);

    first.resolve();
  });
});
