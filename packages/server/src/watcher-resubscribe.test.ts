import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { type DiskEvent, lastKnownHash, startWatcher, type WatcherHandle } from './file-watcher.ts';
import { type HeadWatcherHandle, startHeadWatcher } from './head-watcher.ts';
import { getLogger } from './logger.ts';
import { getMetrics } from './metrics.ts';
import { createManualClock, type ManualClock } from './watcher-clock.test-helper.ts';
import { createWatcherDouble } from './watcher-double.test-helper.ts';

const SLOW_RETRY_MS = 5 * 60_000;

async function flushMicrotasks(): Promise<void> {
  for (let round = 0; round < 5; round++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function until(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const start = performance.now();
  while (!condition()) {
    if (performance.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createsOf(events: readonly DiskEvent[], docName: string): DiskEvent[] {
  return events.filter((event) => event.kind === 'create' && event.docName === docName);
}

describe('content watcher resubscribe', () => {
  let tmpDir: string;
  let contentDir: string;
  let handle: WatcherHandle | undefined;
  let clock: ManualClock;
  let events: DiskEvent[];
  let double: ReturnType<typeof createWatcherDouble>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-watcher-resubscribe-'));
    contentDir = join(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    contentDir = realpathSync(contentDir);
    lastKnownHash.clear();
    clock = createManualClock(Date.now());
    events = [];
    double = createWatcherDouble();
  });

  afterEach(async () => {
    await handle?.unsubscribe();
    handle = undefined;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function watch(freshnessIntervalMs: number | null = null): Promise<void> {
    handle = await startWatcher(
      contentDir,
      async (event) => {
        events.push(event);
      },
      undefined,
      { nativeBackend: double.backend, clock, freshnessIntervalMs },
    );
  }

  test('after a backend error the watcher subscribes again and finds the write made in the gap', async () => {
    await watch();
    const errorsBefore = getMetrics().watcherErrors;
    const resubscribesBefore = getMetrics().watcherResubscribes;
    const first = double.subscriptionFor(contentDir);

    first.fail(new Error('the native watcher died'));
    expect(first.dead).toBe(true);
    expect(getMetrics().watcherErrors - errorsBefore).toBe(1);
    writeFileSync(join(contentDir, 'gap.md'), '# Written while the watcher was dead\n');
    first.deliver([{ type: 'create', path: join(contentDir, 'gap.md') }]);
    expect(createsOf(events, 'gap')).toHaveLength(0);

    clock.advance(0);
    await until(() => double.subscriptionCount(contentDir) === 2, 'a second subscription');
    await until(() => createsOf(events, 'gap').length === 1, 'the gap write to be found');
    expect(getMetrics().watcherResubscribes - resubscribesBefore).toBe(1);
    expect(first.closed).toBe(true);

    const later = join(contentDir, 'later.md');
    writeFileSync(later, '# Delivered by the new subscription\n');
    double.subscriptionFor(contentDir).deliver([{ type: 'create', path: later }]);
    await until(() => createsOf(events, 'later').length === 1, 'the new subscription to deliver');
  });

  async function flush(): Promise<void> {
    for (let round = 0; round < 5; round++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  test('a resubscribe that keeps failing backs off 0, 1 and 5 seconds, then 30 seconds', async () => {
    await watch();
    for (let failure = 0; failure < 3; failure++) {
      double.failNextSubscribe(contentDir, new Error('the backend is not ready yet'));
    }
    double.subscriptionFor(contentDir).fail(new Error('the native watcher died'));

    for (const delayMs of [0, 1_000, 5_000]) {
      if (delayMs > 0) {
        clock.advance(delayMs - 1);
        await flush();
      }
      expect(double.subscriptionCount(contentDir)).toBe(1);
      clock.advance(delayMs === 0 ? 0 : 1);
      await flush();
    }
    clock.advance(29_999);
    await flush();
    expect(double.subscriptionCount(contentDir)).toBe(1);
    clock.advance(1);
    await until(() => double.subscriptionCount(contentDir) === 2, 'the 30 s retry');
  });

  test('after eight failed resubscribes the watcher tries again every five minutes until the fault clears', async () => {
    await watch();
    const warn = vi.spyOn(getLogger('watcher-freshness'), 'warn');
    const gaveUpBefore = getMetrics().watcherResubscribesAbandoned;
    for (let failure = 1; failure <= 8; failure++) {
      double.failNextSubscribe(contentDir, new Error(`no space left for watches ${failure}`));
    }
    double.subscriptionFor(contentDir).fail(new Error('the native watcher died'));
    for (let step = 0; step < 8; step++) {
      clock.advance(30_000);
      await flush();
    }
    expect(getMetrics().watcherResubscribesAbandoned - gaveUpBefore).toBe(1);
    const gaveUp = warn.mock.calls.find(([, message]) =>
      String(message).includes('tries again every 5 minutes'),
    );
    expect((gaveUp?.[0] as { err?: Error } | undefined)?.err?.message).toBe(
      'no space left for watches 8',
    );
    await expect((handle as WatcherHandle).settle()).rejects.toThrow(
      'gave up subscribing after repeated failures (no space left for watches 8)',
    );

    double.failNextSubscribe(contentDir, new Error('still no space'));
    clock.advance(SLOW_RETRY_MS - 1);
    await flush();
    clock.advance(1);
    await flush();
    expect(double.subscriptionCount(contentDir)).toBe(1);

    writeFileSync(join(contentDir, 'while-down.md'), '# Written while the watcher was down\n');
    clock.advance(SLOW_RETRY_MS);
    await until(() => double.subscriptionCount(contentDir) === 2, 'the slow retry to subscribe');
    await until(() => createsOf(events, 'while-down').length === 1, 'the write made while down');
    expect(getMetrics().watcherResubscribesAbandoned - gaveUpBefore).toBe(1);
  });

  test('a watcher whose new subscriptions keep dying within a minute is given up after eight short lives', async () => {
    await watch();
    const gaveUpBefore = getMetrics().watcherResubscribesAbandoned;
    const resubscribesBefore = getMetrics().watcherResubscribes;
    double.subscriptionFor(contentDir).fail(new Error('the first subscription died'));
    for (let life = 1; life <= 8; life++) {
      clock.advance(30_000);
      await until(
        () => getMetrics().watcherResubscribes - resubscribesBefore === life,
        `resubscribe ${life}`,
      );
      expect(getMetrics().watcherResubscribesAbandoned - gaveUpBefore).toBe(0);
      double.subscriptionFor(contentDir).fail(new Error(`short life ${life}`));
    }
    expect(getMetrics().watcherResubscribesAbandoned - gaveUpBefore).toBe(1);
  });

  test('a subscription that lasted a minute is replaced at once, one that died sooner after a delay', async () => {
    await watch();
    const resubscribed = (count: number) => () =>
      double.subscriptionCount(contentDir) === count + 1 &&
      getMetrics().watcherResubscribes - resubscribesBefore === count;
    const resubscribesBefore = getMetrics().watcherResubscribes;

    double.subscriptionFor(contentDir).fail(new Error('first death'));
    clock.advance(0);
    await until(resubscribed(1), 'the first resubscribe');

    double.subscriptionFor(contentDir).fail(new Error('died within a minute'));
    clock.advance(999);
    await flush();
    expect(double.subscriptionCount(contentDir)).toBe(2);
    clock.advance(1);
    await until(resubscribed(2), 'the delayed resubscribe');

    clock.advance(60_000);
    double.subscriptionFor(contentDir).fail(new Error('died after a stable minute'));
    clock.advance(0);
    await until(resubscribed(3), 'the immediate resubscribe');
  });

  test('a deleted content root is watched again once it is recreated', async () => {
    await watch();
    const rootMissingBefore = getMetrics().watcherRootMissing;
    rmSync(contentDir, { recursive: true, force: true });
    double.subscriptionFor(contentDir).deliver([{ type: 'delete', path: contentDir }]);
    expect(getMetrics().watcherRootMissing - rootMissingBefore).toBe(1);

    clock.advance(0);
    clock.advance(1_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(double.subscriptionCount(contentDir)).toBe(1);

    mkdirSync(contentDir);
    writeFileSync(join(contentDir, 'after-recreate.md'), '# After\n');
    clock.advance(1_000);
    await until(() => double.subscriptionCount(contentDir) === 2, 'the root to be watched again');
    await until(
      () => createsOf(events, 'after-recreate').length === 1,
      'the write after the recreate to be found',
    );
  });

  test('the timed pass notices a content root that vanished without any event', async () => {
    await watch(5_000);
    const rootMissingBefore = getMetrics().watcherRootMissing;
    rmSync(contentDir, { recursive: true, force: true });

    clock.advance(5_000);
    expect(getMetrics().watcherRootMissing - rootMissingBefore).toBe(1);

    mkdirSync(contentDir);
    writeFileSync(join(contentDir, 'silent-root.md'), '# Back\n');
    clock.advance(1_000);
    await until(() => double.subscriptionCount(contentDir) === 2, 'the root to be watched again');
    await until(() => createsOf(events, 'silent-root').length === 1, 'the write to be found');
  });
});

describe('HEAD watcher resubscribe', () => {
  let projectRoot: string;
  let gitDir: string;
  let handle: HeadWatcherHandle | undefined;

  beforeEach(() => {
    projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ok-head-resubscribe-')));
    gitDir = join(projectRoot, '.git');
    mkdirSync(gitDir);
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n', 'utf-8');
  });

  afterEach(async () => {
    await handle?.unsubscribe();
    handle = undefined;
    rmSync(projectRoot, { recursive: true, force: true });
  });

  test('after a backend error the HEAD watcher subscribes again and re-reads HEAD in a batch', async () => {
    const double = createWatcherDouble();
    const clock = createManualClock(Date.now());
    const triggers: string[] = [];
    let batchEnds = 0;
    handle = await startHeadWatcher(
      projectRoot,
      ({ trigger }) => {
        triggers.push(trigger);
      },
      () => {
        batchEnds++;
      },
      { forceBackend: 'parcel', nativeBackend: double.backend, clock },
    );

    double.subscriptionFor(gitDir).fail(new Error('the native watcher died'));
    clock.advance(0);
    await until(() => double.subscriptionCount(gitDir) === 2, 'a second HEAD subscription');
    await until(() => triggers.includes('rescan'), 'the HEAD re-read batch');
    clock.advance(100);
    await until(() => batchEnds === 1, 'the re-read batch to end');

    double.subscriptionFor(gitDir).deliver([{ type: 'update', path: join(gitDir, 'HEAD') }]);
    await until(() => triggers.includes('HEAD'), 'the new subscription to open a batch');
    expect(triggers).toEqual(['rescan', 'HEAD']);
  });

  test('a HEAD watcher that gives up says so, tries again every five minutes and says when it is back', async () => {
    const double = createWatcherDouble();
    const clock = createManualClock(Date.now());
    const coverage: string[] = [];
    const triggers: string[] = [];
    handle = await startHeadWatcher(
      projectRoot,
      ({ trigger }) => {
        triggers.push(trigger);
      },
      () => {},
      {
        forceBackend: 'parcel',
        nativeBackend: double.backend,
        clock,
        onGaveUp: (err) => coverage.push(`gave up: ${(err as Error).message}`),
        onBack: () => coverage.push('back'),
      },
    );
    for (let failure = 1; failure <= 8; failure++) {
      double.failNextSubscribe(gitDir, new Error(`watch limit ${failure}`));
    }
    double.subscriptionFor(gitDir).fail(new Error('the native watcher died'));
    for (let step = 0; step < 8; step++) {
      clock.advance(30_000);
      await flushMicrotasks();
    }
    expect(coverage).toEqual(['gave up: watch limit 8']);
    expect(double.subscriptionCount(gitDir)).toBe(1);

    clock.advance(SLOW_RETRY_MS);
    await until(() => coverage.includes('back'), 'the slow retry');
    expect(coverage).toEqual(['gave up: watch limit 8', 'back']);
    expect(double.subscriptionCount(gitDir)).toBe(2);
    await until(() => triggers.includes('rescan'), 'the HEAD re-read once it is back');
  });
});
