import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { getCollector, getHistogramSnapshot } from '../lib/perf/collector';
import { validatePerfMarkName } from '../lib/perf/mark';
import {
  __coldMountSpanCount,
  __resetColdMountSpans,
  emitColdMountChild,
} from '../lib/perf/otel-spans';
import { __resetMountIdRegistry, setMountId } from './mount-id-registry';
import {
  __reapTimedOutEntries,
  __resetSyncPromiseCache,
  __syncPromiseCacheSize,
  __syncPromiseSettled,
  __test_armPendingRejection,
  __test_clearArmedRejection,
  BridgeSetupError,
  getSyncTimeoutMs,
  invalidateSyncPromise,
  PreSyncDisconnectError,
  rejectSyncPromise,
  SyncTimeoutError,
  syncPromise,
  syncPromiseHasResolved,
} from './sync-promise';

const DUMMY_WS = 'ws://localhost:1/collab';

function makeProvider(docName: string): HocuspocusProvider {
  return new HocuspocusProvider({
    url: DUMMY_WS,
    name: docName,
  });
}

let providers: HocuspocusProvider[] = [];
function track<T extends HocuspocusProvider>(p: T): T {
  providers.push(p);
  return p;
}

beforeEach(() => {
  __resetSyncPromiseCache();
  __resetMountIdRegistry();
  providers = [];
});

afterEach(() => {
  __resetSyncPromiseCache();
  __resetMountIdRegistry();
  for (const p of providers) {
    try {
      p.destroy();
    } catch {}
  }
  providers = [];
});

describe('syncPromise creation + idempotency', () => {
  test('creates a cached promise on first call', () => {
    const p = track(makeProvider('doc1'));
    const promise = syncPromise('doc1', p);
    expect(promise).toBeInstanceOf(Promise);
    expect(__syncPromiseCacheSize()).toBe(1);
  });

  test('second call with same docName returns identical reference', () => {
    const p = track(makeProvider('doc1'));
    const a = syncPromise('doc1', p);
    const b = syncPromise('doc1', p);
    expect(a).toBe(b);
    expect(__syncPromiseCacheSize()).toBe(1);
  });

  test('different docNames get different promises', () => {
    const p1 = track(makeProvider('doc1'));
    const p2 = track(makeProvider('doc2'));
    const a = syncPromise('doc1', p1);
    const b = syncPromise('doc2', p2);
    expect(a).not.toBe(b);
    expect(__syncPromiseCacheSize()).toBe(2);
  });
});

describe('syncPromise resolution', () => {
  test('resolves synchronously when provider is already synced (warm path)', async () => {
    const p = track(makeProvider('warm-doc'));
    p.synced = true;
    const promise = syncPromise('warm-doc', p);
    await expect(promise).resolves.toBeUndefined();
    expect(__syncPromiseCacheSize()).toBe(1);
    expect(__syncPromiseSettled('warm-doc')).toBe(true);
  });

  test('warm-path returns the same promise reference on repeat calls', () => {
    const p = track(makeProvider('warm-doc'));
    p.synced = true;
    const a = syncPromise('warm-doc', p);
    const b = syncPromise('warm-doc', p);
    expect(a).toBe(b);
  });

  test('resolves when provider fires synced', async () => {
    const p = track(makeProvider('doc1'));
    const promise = syncPromise('doc1', p);

    queueMicrotask(() => p.emit('synced', { state: true }));

    await expect(promise).resolves.toBeUndefined();
    expect(__syncPromiseCacheSize()).toBe(1);
    expect(__syncPromiseSettled('doc1')).toBe(true);
  });

  test('resolves only once even if synced fires multiple times', async () => {
    const p = track(makeProvider('doc1'));
    const promise = syncPromise('doc1', p);

    p.emit('synced', { state: true });
    p.emit('synced', { state: true });
    p.emit('synced', { state: true });

    await expect(promise).resolves.toBeUndefined();
    expect(__syncPromiseSettled('doc1')).toBe(true);
  });

  test('after synced, a new call returns the same cached resolved promise', async () => {
    const p = track(makeProvider('doc1'));
    const first = syncPromise('doc1', p);
    p.emit('synced', { state: true });
    await first;

    const second = syncPromise('doc1', p);
    expect(second).toBe(first);
    expect(__syncPromiseCacheSize()).toBe(1);
  });
});

describe('syncPromise pre-sync close rejection', () => {
  test('rejects with PreSyncDisconnectError when close fires before synced', async () => {
    const p = track(makeProvider('doc1'));
    const promise = syncPromise('doc1', p);

    queueMicrotask(() => {
      p.emit('close', { event: { code: 1006, reason: 'test', wasClean: false } });
    });

    await expect(promise).rejects.toBeInstanceOf(PreSyncDisconnectError);
    expect(__syncPromiseSettled('doc1')).toBe(true);
  });

  test('repeat call after rejection returns the same rejected promise', async () => {
    const p = track(makeProvider('doc1'));
    const first = syncPromise('doc1', p);
    p.emit('close', { event: { code: 1006, reason: 'test', wasClean: false } });
    await first.catch(() => {}); // settle the rejection

    const second = syncPromise('doc1', p);
    expect(second).toBe(first);
    await expect(second).rejects.toBeInstanceOf(PreSyncDisconnectError);
  });

  test('PreSyncDisconnectError carries docName', async () => {
    const p = track(makeProvider('doc-with-name'));
    const promise = syncPromise('doc-with-name', p);
    queueMicrotask(() => {
      p.emit('close', { event: { code: 1006, reason: 'test', wasClean: false } });
    });

    try {
      await promise;
      throw new Error('should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(PreSyncDisconnectError);
      expect((err as PreSyncDisconnectError).docName).toBe('doc-with-name');
      expect((err as Error).message).toContain('doc-with-name');
    }
  });

  test('close after synced does not re-reject (entry settled)', async () => {
    const p = track(makeProvider('doc1'));
    const promise = syncPromise('doc1', p);
    p.emit('synced', { state: true });
    await promise;

    p.emit('close', { event: { code: 1000, reason: 'normal', wasClean: true } });
    expect(__syncPromiseSettled('doc1')).toBe(true);
  });
});

describe('syncPromise timeout', () => {
  test('rejects with SyncTimeoutError after 30s elapsed', async () => {
    const p = track(makeProvider('slow-doc'));
    const origSetTimeout = globalThis.setTimeout;
    let capturedTimer: (() => void) | null = null;
    // @ts-expect-error — intentional override for test
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      if (ms === getSyncTimeoutMs()) {
        capturedTimer = fn;
        return { __dummy: true } as unknown as ReturnType<typeof origSetTimeout>;
      }
      return origSetTimeout(fn, ms);
    }) as typeof globalThis.setTimeout;

    try {
      const promise = syncPromise('slow-doc', p);
      expect(capturedTimer).not.toBeNull();
      capturedTimer?.();
      await expect(promise).rejects.toBeInstanceOf(SyncTimeoutError);
      expect(__syncPromiseSettled('slow-doc')).toBe(true);
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
  });

  test('SyncTimeoutError carries docName + elapsedMs', async () => {
    const p = track(makeProvider('slow-doc'));
    const origSetTimeout = globalThis.setTimeout;
    let capturedTimer: (() => void) | null = null;
    // @ts-expect-error — intentional override for test
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      if (ms === getSyncTimeoutMs()) {
        capturedTimer = fn;
        return { __dummy: true } as unknown as ReturnType<typeof origSetTimeout>;
      }
      return origSetTimeout(fn, ms);
    }) as typeof globalThis.setTimeout;

    try {
      const promise = syncPromise('slow-doc', p);
      capturedTimer?.();
      try {
        await promise;
        throw new Error('should have rejected');
      } catch (err) {
        expect(err).toBeInstanceOf(SyncTimeoutError);
        expect((err as SyncTimeoutError).docName).toBe('slow-doc');
        expect((err as SyncTimeoutError).elapsedMs).toBeGreaterThanOrEqual(0);
      }
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
  });
});

describe('invalidateSyncPromise', () => {
  test('removes the cache entry without rejecting', async () => {
    const p = track(makeProvider('doc1'));
    const promise = syncPromise('doc1', p);
    expect(__syncPromiseCacheSize()).toBe(1);

    invalidateSyncPromise('doc1');
    expect(__syncPromiseCacheSize()).toBe(0);

    const result = await Promise.race([
      promise.then(() => 'resolved'),
      promise.catch(() => 'rejected'),
      new Promise<string>((r) => setTimeout(() => r('pending'), 50)),
    ]);
    expect(result).toBe('pending');
  });

  test('after invalidate, next call returns fresh promise', () => {
    const p = track(makeProvider('doc1'));
    const first = syncPromise('doc1', p);
    invalidateSyncPromise('doc1');

    const second = syncPromise('doc1', p);
    expect(second).not.toBe(first);
    expect(__syncPromiseCacheSize()).toBe(1);
  });

  test('after rejection + invalidate, next call returns fresh promise (retry path)', async () => {
    const p = track(makeProvider('doc1'));
    const first = syncPromise('doc1', p);
    p.emit('close', { event: { code: 1006, reason: 'test', wasClean: false } });
    await first.catch(() => {});

    expect(syncPromise('doc1', p)).toBe(first);

    invalidateSyncPromise('doc1');
    const fresh = syncPromise('doc1', p);
    expect(fresh).not.toBe(first);
  });

  test('invalidate is idempotent / no-op when entry missing', () => {
    expect(() => invalidateSyncPromise('never-created')).not.toThrow();
    expect(__syncPromiseCacheSize()).toBe(0);
  });

  test('after invalidate, synced on the old provider does NOT settle the orphaned promise', async () => {
    const p = track(makeProvider('doc1'));
    const orphaned = syncPromise('doc1', p);
    invalidateSyncPromise('doc1');

    p.emit('synced', { state: true });

    const result = await Promise.race([
      orphaned.then(() => 'resolved'),
      orphaned.catch(() => 'rejected'),
      new Promise<string>((r) => setTimeout(() => r('pending'), 50)),
    ]);
    expect(result).toBe('pending');
  });
});

describe('rejectSyncPromise (BridgeSetupError surface)', () => {
  test('rejects an active cache entry with the supplied error', async () => {
    const p = track(makeProvider('doc1'));
    const promise = syncPromise('doc1', p);
    const cause = new Error('observer wiring failed');

    const ok = rejectSyncPromise('doc1', new BridgeSetupError('doc1', cause));
    expect(ok).toBe(true);

    try {
      await promise;
      throw new Error('should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeSetupError);
      expect((err as BridgeSetupError).docName).toBe('doc1');
      expect((err as BridgeSetupError).cause).toBe(cause);
    }
  });

  test('rejected entry stays in cache so subsequent renders catch the same error', async () => {
    const p = track(makeProvider('doc1'));
    const first = syncPromise('doc1', p);
    rejectSyncPromise('doc1', new BridgeSetupError('doc1'));
    await first.catch(() => {});

    const second = syncPromise('doc1', p);
    expect(second).toBe(first);
    await expect(second).rejects.toBeInstanceOf(BridgeSetupError);
  });

  test('returns false when no entry exists', () => {
    const ok = rejectSyncPromise('never-created', new BridgeSetupError('never-created'));
    expect(ok).toBe(false);
  });

  test('returns false on already-settled entry (idempotent)', async () => {
    const p = track(makeProvider('doc1'));
    const promise = syncPromise('doc1', p);
    rejectSyncPromise('doc1', new BridgeSetupError('doc1'));
    await promise.catch(() => {});

    const ok = rejectSyncPromise('doc1', new BridgeSetupError('doc1'));
    expect(ok).toBe(false);
  });
});

describe('syncPromiseHasResolved (warm-reopen overlay gate)', () => {
  test('returns false when no entry exists', () => {
    expect(syncPromiseHasResolved('never-mounted')).toBe(false);
  });

  test('returns true on warm-provider sentinel (provider.synced=true at create-time)', () => {
    const provider = track(makeProvider('warm-doc'));
    Object.defineProperty(provider, 'synced', { value: true, configurable: true });
    syncPromise('warm-doc', provider);
    expect(syncPromiseHasResolved('warm-doc')).toBe(true);
  });

  test('returns false while pending, true after onSynced fires', () => {
    const provider = track(makeProvider('cold-doc'));
    Object.defineProperty(provider, 'synced', { value: false, configurable: true });
    syncPromise('cold-doc', provider);
    expect(syncPromiseHasResolved('cold-doc')).toBe(false);
    // biome-ignore lint/suspicious/noExplicitAny: protected emit() needs reach for tests
    (provider as any).emit('synced', { state: false });
    expect(syncPromiseHasResolved('cold-doc')).toBe(true);
  });

  test('returns false on rejected promise (settled but not resolved)', () => {
    const provider = track(makeProvider('rejected-doc'));
    Object.defineProperty(provider, 'synced', { value: false, configurable: true });
    const promise = syncPromise('rejected-doc', provider);
    rejectSyncPromise('rejected-doc', new BridgeSetupError('rejected-doc'));
    promise.catch(() => {}); // Suppress unhandled-rejection.
    expect(__syncPromiseSettled('rejected-doc')).toBe(true);
    expect(syncPromiseHasResolved('rejected-doc')).toBe(false);
  });

  test('returns false on armed-rejection sentinel', () => {
    __test_armPendingRejection('armed-doc', 'timeout');
    const provider = track(makeProvider('armed-doc'));
    Object.defineProperty(provider, 'synced', { value: false, configurable: true });
    const promise = syncPromise('armed-doc', provider);
    promise.catch(() => {});
    expect(syncPromiseHasResolved('armed-doc')).toBe(false);
  });

  test('returns false after invalidate (entry removed)', () => {
    const provider = track(makeProvider('invalidated-doc'));
    Object.defineProperty(provider, 'synced', { value: true, configurable: true });
    syncPromise('invalidated-doc', provider);
    expect(syncPromiseHasResolved('invalidated-doc')).toBe(true);
    invalidateSyncPromise('invalidated-doc');
    expect(syncPromiseHasResolved('invalidated-doc')).toBe(false);
  });
});

describe('production dial', () => {
  test('getSyncTimeoutMs() returns 30_000 by default (no override)', () => {
    expect(getSyncTimeoutMs()).toBe(30_000);
  });
});

describe('error class shape', () => {
  test('SyncTimeoutError extends Error and has `name`', () => {
    const err = new SyncTimeoutError('foo', 30_000);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SyncTimeoutError');
    expect(err.docName).toBe('foo');
    expect(err.elapsedMs).toBe(30_000);
  });

  test('PreSyncDisconnectError extends Error and has `name`', () => {
    const err = new PreSyncDisconnectError('bar');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PreSyncDisconnectError');
    expect(err.docName).toBe('bar');
  });

  test('BridgeSetupError extends Error and carries docName + cause', () => {
    const cause = new Error('schema mismatch');
    const err = new BridgeSetupError('baz', cause);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('BridgeSetupError');
    expect(err.docName).toBe('baz');
    expect(err.cause).toBe(cause);
    expect(err.message).toContain('baz');
    expect(err.message).toContain('schema mismatch');
  });
});

describe('__test_armPendingRejection — race-free e2e error-path hook', () => {
  test('arms a rejection that fires on the next syncPromise creation with timeout kind', async () => {
    const p = track(makeProvider('doc-armed-timeout'));
    __test_armPendingRejection('doc-armed-timeout', 'timeout');
    const promise = syncPromise('doc-armed-timeout', p);
    await expect(promise).rejects.toBeInstanceOf(SyncTimeoutError);
    expect(__test_clearArmedRejection('doc-armed-timeout')).toBe(false);
  });

  test('arms a rejection with predisconnect kind', async () => {
    const p = track(makeProvider('doc-armed-predisconnect'));
    __test_armPendingRejection('doc-armed-predisconnect', 'predisconnect');
    const promise = syncPromise('doc-armed-predisconnect', p);
    await expect(promise).rejects.toBeInstanceOf(PreSyncDisconnectError);
  });

  test('defaults to timeout kind when kind is omitted', async () => {
    const p = track(makeProvider('doc-armed-default'));
    __test_armPendingRejection('doc-armed-default');
    const promise = syncPromise('doc-armed-default', p);
    await expect(promise).rejects.toBeInstanceOf(SyncTimeoutError);
  });

  test('arm takes priority over warm-provider fast path', async () => {
    const p = track(makeProvider('doc-armed-warm'));
    p.synced = true;
    __test_armPendingRejection('doc-armed-warm', 'timeout');
    const promise = syncPromise('doc-armed-warm', p);
    await expect(promise).rejects.toBeInstanceOf(SyncTimeoutError);
  });

  test('is one-shot: second syncPromise call returns the cached rejected promise', async () => {
    const p = track(makeProvider('doc-armed-once'));
    __test_armPendingRejection('doc-armed-once', 'timeout');

    const first = syncPromise('doc-armed-once', p);
    await expect(first).rejects.toBeInstanceOf(SyncTimeoutError);

    const second = syncPromise('doc-armed-once', p);
    expect(second).toBe(first);

    expect(__test_clearArmedRejection('doc-armed-once')).toBe(false);
  });

  test('arm is consumed on creation, so a fresh syncPromise after invalidate is NOT armed', async () => {
    const p = track(makeProvider('doc-consumed-arm'));
    __test_armPendingRejection('doc-consumed-arm', 'timeout');
    const first = syncPromise('doc-consumed-arm', p);
    await expect(first).rejects.toBeInstanceOf(SyncTimeoutError);

    invalidateSyncPromise('doc-consumed-arm');
    expect(__test_clearArmedRejection('doc-consumed-arm')).toBe(false);

    const fresh = syncPromise('doc-consumed-arm', p);
    expect(__syncPromiseSettled('doc-consumed-arm')).toBe(false);
    fresh.catch(() => {});
  });

  test('__test_clearArmedRejection returns true when an arm was removed, false otherwise', () => {
    __test_armPendingRejection('doc-clear', 'timeout');
    expect(__test_clearArmedRejection('doc-clear')).toBe(true);
    expect(__test_clearArmedRejection('doc-clear')).toBe(false);
    expect(__test_clearArmedRejection('never-armed')).toBe(false);
  });

  test('__resetSyncPromiseCache also clears pending arms', () => {
    __test_armPendingRejection('doc-leak', 'timeout');
    __resetSyncPromiseCache();
    expect(__test_clearArmedRejection('doc-leak')).toBe(false);
  });
});

describe('tab-sleep resilience (__reapTimedOutEntries)', () => {
  test('rejects pending entry when elapsed wall-clock time exceeds timeout', async () => {
    const p = track(makeProvider('sleepy-doc'));
    const promise = syncPromise('sleepy-doc', p);
    const settled = promise.catch((e: unknown) => e);

    const createdAt = Date.now();
    const rejected = __reapTimedOutEntries(createdAt + getSyncTimeoutMs() + 1_000);

    expect(rejected).toBe(1);
    const result = await settled;
    expect(result).toBeInstanceOf(SyncTimeoutError);
    expect(__syncPromiseSettled('sleepy-doc')).toBe(true);
  });

  test('does not reject entries whose elapsed time is within the timeout', () => {
    const p = track(makeProvider('quick-doc'));
    const promise = syncPromise('quick-doc', p);
    promise.catch(() => {}); // Prevent unhandled rejection in teardown

    const rejected = __reapTimedOutEntries(Date.now() + 1_000);

    expect(rejected).toBe(0);
    expect(__syncPromiseSettled('quick-doc')).toBe(false);
  });

  test('skips already-settled entries (idempotent re-entrance)', async () => {
    const p = track(makeProvider('synced-doc'));
    const promise = syncPromise('synced-doc', p);
    queueMicrotask(() => p.emit('synced', { state: true }));
    await promise;

    const rejected = __reapTimedOutEntries(Date.now() + getSyncTimeoutMs() * 2);

    expect(rejected).toBe(0);
    expect(__syncPromiseSettled('synced-doc')).toBe(true);
  });
});

describe('mountId payload (US-006 / FR5 / AC13 — cross-namespace correlation)', () => {
  test('every ok/sync/* mark carries the mountId from the registry (warm-path resolve)', async () => {
    const collector = getCollector();
    if (!collector) {
      return;
    }
    setMountId('mid-sync-doc', 'specific-sync-mount-id');
    const beforeMarks = collector.marks.toArray().length;
    const p = track(makeProvider('mid-sync-doc'));
    p.synced = true; // warm-path: synchronous create + resolve
    await syncPromise('mid-sync-doc', p);
    const newMarks = collector.marks.toArray().slice(beforeMarks);
    const syncMarks = newMarks.filter((m) => m.name.startsWith('ok/sync/'));
    expect(syncMarks.length).toBeGreaterThan(0);
    for (const m of syncMarks) {
      expect(m.properties?.mountId).toBe('specific-sync-mount-id');
    }
  });

  test('every ok/sync/* mark carries the mountId across cold-path resolve', async () => {
    const collector = getCollector();
    if (!collector) return;
    setMountId('cold-sync-doc', 'cold-sync-mount-id');
    const beforeMarks = collector.marks.toArray().length;
    const p = track(makeProvider('cold-sync-doc'));
    const promise = syncPromise('cold-sync-doc', p);
    queueMicrotask(() => p.emit('synced', { state: true }));
    await promise;
    const newMarks = collector.marks.toArray().slice(beforeMarks);
    const syncMarks = newMarks.filter((m) => m.name.startsWith('ok/sync/'));
    expect(syncMarks.length).toBeGreaterThan(0);
    for (const m of syncMarks) {
      expect(m.properties?.mountId).toBe('cold-sync-mount-id');
    }
  });
});

describe('ok/sync/resolve-elapsed-ms histogram (cap-graduation sweep substrate)', () => {
  beforeEach(() => {
    getCollector()?.reset();
  });

  test('histogram bucket name passes validatePerfMarkName', () => {
    expect(validatePerfMarkName('ok/sync/resolve-elapsed-ms')).toBe(true);
  });

  test('warm-path resolve increments the histogram with elapsedMs=0', async () => {
    setMountId('h-warm', 'h-warm-mid');
    const p = track(makeProvider('h-warm'));
    p.synced = true;
    await syncPromise('h-warm', p);
    const snap = getHistogramSnapshot('ok/sync/resolve-elapsed-ms');
    expect(snap).toBeDefined();
    expect(snap?.count).toBe(1);
  });

  test('warm-path paired mark carries warm:true, durationMs:0, docName, mountId', async () => {
    const collector = getCollector();
    if (!collector) return;
    setMountId('h-warm-pair', 'h-warm-pair-mid');
    const p = track(makeProvider('h-warm-pair'));
    p.synced = true;
    await syncPromise('h-warm-pair', p);
    const histMarks = collector.marks
      .toArray()
      .filter(
        (m) => m.name === 'ok/sync/resolve-elapsed-ms' && m.properties?.docName === 'h-warm-pair',
      );
    expect(histMarks.length).toBe(1);
    const props = histMarks[0]?.properties;
    expect(props?.warm).toBe(true);
    expect(props?.durationMs).toBe(0);
    expect(props?.mountId).toBe('h-warm-pair-mid');
  });

  test('cold-path resolve increments the histogram with the measured elapsedMs', async () => {
    setMountId('h-cold', 'h-cold-mid');
    const p = track(makeProvider('h-cold'));
    const promise = syncPromise('h-cold', p);
    queueMicrotask(() => p.emit('synced', { state: true }));
    await promise;
    const snap = getHistogramSnapshot('ok/sync/resolve-elapsed-ms');
    expect(snap).toBeDefined();
    expect(snap?.count).toBe(1);
    expect(snap?.max).toBeGreaterThanOrEqual(0);
    expect(snap?.max).toBeLessThan(30_000);
  });

  test('cold-path paired mark carries docName + mountId (no warm flag)', async () => {
    const collector = getCollector();
    if (!collector) return;
    setMountId('h-cold-pair', 'h-cold-pair-mid');
    const p = track(makeProvider('h-cold-pair'));
    const promise = syncPromise('h-cold-pair', p);
    queueMicrotask(() => p.emit('synced', { state: true }));
    await promise;
    const histMarks = collector.marks
      .toArray()
      .filter(
        (m) => m.name === 'ok/sync/resolve-elapsed-ms' && m.properties?.docName === 'h-cold-pair',
      );
    expect(histMarks.length).toBe(1);
    const props = histMarks[0]?.properties;
    expect(props?.docName).toBe('h-cold-pair');
    expect(props?.mountId).toBe('h-cold-pair-mid');
    expect(props?.warm).toBeUndefined();
  });

  test('existing ok/sync/resolve mark is preserved alongside the histogram', async () => {
    const collector = getCollector();
    if (!collector) return;
    setMountId('h-coexist', 'h-coexist-mid');
    const p = track(makeProvider('h-coexist'));
    const promise = syncPromise('h-coexist', p);
    queueMicrotask(() => p.emit('synced', { state: true }));
    await promise;
    const resolveMarks = collector.marks
      .toArray()
      .filter((m) => m.name === 'ok/sync/resolve' && m.properties?.docName === 'h-coexist');
    expect(resolveMarks.length).toBe(1);
  });
});

describe('cold-mount span finalization on reject paths', () => {
  beforeEach(() => {
    __resetColdMountSpans();
  });

  afterEach(() => {
    __resetColdMountSpans();
  });

  test('onClose pre-sync-disconnect path finalizes the cold-mount span', async () => {
    setMountId('reject-close', 'reject-close-mid');
    emitColdMountChild('reject-close-mid', 'ok.provider-pool.open', {}, Date.now(), Date.now() + 1);
    expect(__coldMountSpanCount()).toBe(1);

    const p = track(makeProvider('reject-close'));
    const promise = syncPromise('reject-close', p);
    queueMicrotask(() => {
      p.emit('close', { event: { code: 1006, reason: 'test', wasClean: false } });
    });
    await expect(promise).rejects.toBeInstanceOf(PreSyncDisconnectError);
    expect(__coldMountSpanCount()).toBe(0);
  });

  test('setTimeout-fired timeout path finalizes the cold-mount span', async () => {
    setMountId('reject-timeout', 'reject-timeout-mid');
    emitColdMountChild(
      'reject-timeout-mid',
      'ok.provider-pool.open',
      {},
      Date.now(),
      Date.now() + 1,
    );
    expect(__coldMountSpanCount()).toBe(1);

    const p = track(makeProvider('reject-timeout'));
    const origSetTimeout = globalThis.setTimeout;
    let capturedTimer: (() => void) | null = null;
    // @ts-expect-error — intentional test override for the 30s timer
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      if (ms === getSyncTimeoutMs()) {
        capturedTimer = fn;
        return { __dummy: true } as unknown as ReturnType<typeof origSetTimeout>;
      }
      return origSetTimeout(fn, ms);
    }) as typeof globalThis.setTimeout;

    try {
      const promise = syncPromise('reject-timeout', p);
      capturedTimer?.();
      await expect(promise).rejects.toBeInstanceOf(SyncTimeoutError);
      expect(__coldMountSpanCount()).toBe(0);
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
  });

  test('__reapTimedOutEntries visibility-restore path finalizes the cold-mount span', async () => {
    setMountId('reject-reap', 'reject-reap-mid');
    emitColdMountChild('reject-reap-mid', 'ok.provider-pool.open', {}, Date.now(), Date.now() + 1);
    expect(__coldMountSpanCount()).toBe(1);

    const p = track(makeProvider('reject-reap'));
    const promise = syncPromise('reject-reap', p);
    const settled = promise.catch((e: unknown) => e);
    __reapTimedOutEntries(Date.now() + getSyncTimeoutMs() + 1_000);
    const result = await settled;
    expect(result).toBeInstanceOf(SyncTimeoutError);
    expect(__coldMountSpanCount()).toBe(0);
  });

  test('rejectSyncPromise (BridgeSetupError surface) finalizes the cold-mount span', async () => {
    setMountId('reject-explicit', 'reject-explicit-mid');
    emitColdMountChild(
      'reject-explicit-mid',
      'ok.provider-pool.open',
      {},
      Date.now(),
      Date.now() + 1,
    );
    expect(__coldMountSpanCount()).toBe(1);

    const p = track(makeProvider('reject-explicit'));
    const promise = syncPromise('reject-explicit', p);
    const settled = promise.catch((e: unknown) => e);
    rejectSyncPromise('reject-explicit', new BridgeSetupError('reject-explicit', 'test cause'));
    const result = await settled;
    expect(result).toBeInstanceOf(BridgeSetupError);
    expect(__coldMountSpanCount()).toBe(0);
  });
});
