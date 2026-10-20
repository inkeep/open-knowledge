import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  CHOKIDAR_BATCH_WINDOW_MS,
  type DiskEvent,
  lastKnownHash,
  startWatcher,
  type WatcherHandle,
} from './file-watcher.ts';
import { createManualClock } from './watcher-clock.test-helper.ts';
import { createWatcherDouble } from './watcher-double.test-helper.ts';

async function until(condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function createsOf(events: readonly DiskEvent[], docName: string): DiskEvent[] {
  return events.filter((event) => event.kind === 'create' && event.docName === docName);
}

describe('file watcher with an injected backend', () => {
  let tmpDir: string;
  let contentDir: string;
  let handle: WatcherHandle | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-watcher-backend-'));
    contentDir = join(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    lastKnownHash.clear();
  });

  afterEach(async () => {
    await handle?.unsubscribe();
    handle = undefined;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('the backend is subscribed on the content directory and its events reach the disk-event callback', async () => {
    const double = createWatcherDouble();
    const events: DiskEvent[] = [];
    handle = await startWatcher(
      contentDir,
      async (event) => {
        events.push(event);
      },
      undefined,
      { nativeBackend: double.backend },
    );
    const canonicalDir = realpathSync(contentDir);
    const subscription = double.subscriptionFor(canonicalDir);
    expect(subscription.closed).toBe(false);

    const file = join(canonicalDir, 'delivered.md');
    writeFileSync(file, '# Delivered\n');
    subscription.deliver([{ type: 'create', path: file }]);
    await until(
      () => createsOf(events, 'delivered').length > 0,
      'the delivered create to reach the callback',
    );
    expect(handle.getFileIndex().has('delivered')).toBe(true);

    await handle.unsubscribe();
    handle = undefined;
    expect(subscription.closed).toBe(true);
  });

  test('a re-check finds and applies a write the backend never delivered, and reports what it found', async () => {
    const double = createWatcherDouble();
    const events: DiskEvent[] = [];
    handle = await startWatcher(
      contentDir,
      async (event) => {
        events.push(event);
      },
      undefined,
      { nativeBackend: double.backend },
    );
    const canonicalDir = realpathSync(contentDir);
    writeFileSync(join(canonicalDir, 'silent.md'), '# Silent\n');

    const before = events.length;
    const result = await handle.recheck();
    const pass = events.slice(before);
    expect(result.status).toBe('completed');
    expect(result.candidates).toBeGreaterThanOrEqual(1);
    expect(result.dispatched).toBeGreaterThanOrEqual(1);
    expect(pass.filter((event) => event.kind === 'create')).toHaveLength(result.dispatched);
    expect(createsOf(pass, 'silent')).toHaveLength(1);
    expect(handle.getFileIndex().has('silent')).toBe(true);

    const again = await handle.recheck();
    expect(again).toEqual({ status: 'completed', candidates: 0, dispatched: 0 });
  });

  test('concurrent re-check requests coalesce into one pass', async () => {
    const double = createWatcherDouble();
    handle = await startWatcher(contentDir, async () => {}, undefined, {
      nativeBackend: double.backend,
    });
    writeFileSync(join(realpathSync(contentDir), 'once.md'), '# Once\n');
    const first = handle.recheck();
    const second = handle.recheck();
    expect(second).toBe(first);
    const result = await first;
    expect(result.status).toBe('completed');
    expect(result.candidates).toBeGreaterThanOrEqual(1);
  });

  test('a backend error does not stop a later re-check', async () => {
    const double = createWatcherDouble();
    const events: DiskEvent[] = [];
    handle = await startWatcher(
      contentDir,
      async (event) => {
        events.push(event);
      },
      undefined,
      { nativeBackend: double.backend },
    );
    const canonicalDir = realpathSync(contentDir);
    double.subscriptionFor(canonicalDir).fail(new Error('boom'));
    writeFileSync(join(canonicalDir, 'after-error.md'), '# After\n');
    const result = await handle.recheck();
    expect(result.status).toBe('completed');
    expect(createsOf(events, 'after-error')).toHaveLength(1);
  });

  test('a rescan notice from the backend runs a recovery that finds undelivered writes', async () => {
    const double = createWatcherDouble();
    const events: DiskEvent[] = [];
    handle = await startWatcher(
      contentDir,
      async (event) => {
        events.push(event);
      },
      undefined,
      { nativeBackend: double.backend },
    );
    const canonicalDir = realpathSync(contentDir);
    writeFileSync(join(canonicalDir, 'rescanned.md'), '# Rescanned\n');
    double.subscriptionFor(canonicalDir).rescan();
    await until(
      () => createsOf(events, 'rescanned').length > 0,
      'the rescan recovery to deliver the create',
    );
    expect(handle.getFileIndex().has('rescanned')).toBe(true);
  });
});

describe('file watcher re-check on the chokidar backend', () => {
  let tmpDir: string;
  let contentDir: string;
  let handle: WatcherHandle | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-watcher-chokidar-'));
    contentDir = join(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    lastKnownHash.clear();
  });

  afterEach(async () => {
    await handle?.unsubscribe();
    handle = undefined;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('a write the re-check applied before the chokidar batch fired is created once', async () => {
    const clock = createManualClock();
    const events: DiskEvent[] = [];
    const rawBatches: (readonly string[])[] = [];
    handle = await startWatcher(
      contentDir,
      async (event) => {
        events.push(event);
      },
      undefined,
      {
        forceBackend: 'chokidar',
        clock,
        onRawBatch: (paths) => {
          rawBatches.push(paths);
        },
      },
    );
    const baseline = clock.pendingTimers();
    const file = join(realpathSync(contentDir), 'chokidar.md');
    writeFileSync(file, '# Chokidar\n');
    await until(
      () => clock.pendingTimers() > baseline,
      'chokidar to park its batch timer on the manual clock',
    );
    expect(clock.pendingTimers()).toBe(baseline + 1);

    const result = await handle.recheck();
    expect(result.status).toBe('completed');
    expect(result.dispatched).toBe(1);
    expect(createsOf(events, 'chokidar')).toHaveLength(1);

    rawBatches.length = 0;
    clock.advance(CHOKIDAR_BATCH_WINDOW_MS);
    await until(
      () => rawBatches.some((paths) => paths.includes(file)),
      'the parked chokidar batch to start',
    );

    const again = await handle.recheck();
    expect(again.status).toBe('completed');
    expect(again.candidates).toBe(0);
    expect(createsOf(events, 'chokidar')).toHaveLength(1);
  });
});
