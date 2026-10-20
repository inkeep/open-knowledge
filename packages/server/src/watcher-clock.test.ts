import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  evictStaleTrackerEntries,
  isSelfRemoval,
  registerRemoval,
  registerWrite,
  removalTracker,
  startWatcher,
  type WatcherHandle,
  writeTracker,
} from './file-watcher.ts';
import type { NativeWatcherBackend } from './parcel-subscription.ts';
import { createManualClock } from './watcher-clock.test-helper.ts';
import {
  installWatcherClock,
  systemWatcherClock,
  type WatcherClock,
  watcherClock,
} from './watcher-clock.ts';
import { createWatcherDouble } from './watcher-double.test-helper.ts';

describe('watcher clock', () => {
  let restore: (() => void) | undefined;
  let dir: string;
  const running = new Set<WatcherHandle>();

  async function start(contentDir: string, clock: WatcherClock): Promise<WatcherHandle> {
    mkdirSync(contentDir, { recursive: true });
    const handle = await startWatcher(contentDir, async () => {}, undefined, {
      nativeBackend: createWatcherDouble().backend,
      clock,
    });
    running.add(handle);
    return handle;
  }

  async function stop(handle: WatcherHandle): Promise<void> {
    running.delete(handle);
    await handle.unsubscribe();
  }

  afterEach(async () => {
    for (const handle of running) await handle.unsubscribe();
    running.clear();
    restore?.();
    restore = undefined;
    writeTracker.clear();
    removalTracker.clear();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('the system clock is active until one is installed, and the restore puts it back', () => {
    expect(watcherClock()).toBe(systemWatcherClock);
    const manual = createManualClock();
    restore = installWatcherClock(manual);
    expect(watcherClock()).toBe(manual);
    restore();
    restore = undefined;
    expect(watcherClock()).toBe(systemWatcherClock);
  });

  test('write-tracker eviction reads the installed clock, not the wall clock', () => {
    dir = mkdtempSync(join(tmpdir(), 'ok-watcher-clock-'));
    const manual = createManualClock();
    restore = installWatcherClock(manual);
    const file = join(dir, 'doc.md');
    registerWrite(file, 'hash-1');
    expect(writeTracker.size).toBe(1);

    manual.advance(9_999);
    evictStaleTrackerEntries();
    expect(writeTracker.size).toBe(1);

    manual.advance(2);
    evictStaleTrackerEntries();
    expect(writeTracker.size).toBe(0);
  });

  test('a declared removal is a self removal only inside its window on the installed clock', () => {
    dir = mkdtempSync(join(tmpdir(), 'ok-watcher-clock-'));
    const manual = createManualClock();
    restore = installWatcherClock(manual);
    const file = join(dir, 'gone.md');

    registerRemoval(file);
    manual.advance(30_001);
    expect(isSelfRemoval(file)).toBe(false);

    registerRemoval(file);
    manual.advance(29_999);
    expect(isSelfRemoval(file)).toBe(true);
  });

  test('the manual clock runs timers in due order and reschedules intervals', () => {
    const manual = createManualClock(1_000);
    const order: string[] = [];
    manual.setTimeout(() => order.push('late'), 50);
    manual.setTimeout(() => order.push('early'), 10);
    const interval = manual.setInterval(() => order.push('tick'), 20);
    manual.advance(55);
    expect(order).toEqual(['early', 'tick', 'tick', 'late']);
    expect(manual.now()).toBe(1_055);
    manual.clearInterval(interval);
    manual.advance(100);
    expect(order).toEqual(['early', 'tick', 'tick', 'late']);
    expect(manual.pendingTimers()).toBe(0);
  });

  test('a started watcher installs its clock until it unsubscribes', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ok-watcher-clock-'));
    const manual = createManualClock();
    const handle = await start(join(dir, 'content'), manual);
    expect(watcherClock()).toBe(manual);

    await stop(handle);
    expect(watcherClock()).toBe(systemWatcherClock);
  });

  test('a watcher that fails to start leaves the system clock installed and no timers behind', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ok-watcher-clock-'));
    const manual = createManualClock();
    const refusingBackend: NativeWatcherBackend = {
      subscribe: async () => {
        throw new Error('subscribe refused');
      },
    };
    await expect(
      startWatcher(dir, async () => {}, undefined, {
        forceBackend: 'parcel',
        nativeBackend: refusingBackend,
        clock: manual,
      }),
    ).rejects.toThrow('forced backend');
    expect(watcherClock()).toBe(systemWatcherClock);
    expect(manual.pendingTimers()).toBe(0);
  });

  test('two watchers on two clocks unwind to the system clock when stopped in start order', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ok-watcher-clock-'));
    const first = createManualClock();
    const second = createManualClock();
    const firstHandle = await start(join(dir, 'first'), first);
    expect(watcherClock()).toBe(first);
    const secondHandle = await start(join(dir, 'second'), second);
    expect(watcherClock()).toBe(second);

    await stop(firstHandle);
    expect(watcherClock()).toBe(second);

    await stop(secondHandle);
    expect(watcherClock()).toBe(systemWatcherClock);
  });

  test('calling a restore twice removes only the entry it installed', () => {
    const manual = createManualClock();
    const restoreFirst = installWatcherClock(manual);
    const restoreSecond = installWatcherClock(manual);

    restoreFirst();
    restoreFirst();
    expect(watcherClock()).toBe(manual);

    restoreSecond();
    expect(watcherClock()).toBe(systemWatcherClock);
  });
});
