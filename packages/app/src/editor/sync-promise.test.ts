/**
 * Unit tests for sync-promise: module-level cache + timeout + invalidation.
 *
 * These tests drive a real HocuspocusProvider pointed at a dummy WS URL
 * (same pattern as provider-pool.test.ts). The provider never connects,
 * but emitting `synced` / `close` directly exercises the listener wiring.
 */
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
    } catch {
      // ignore
    }
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
    // Pool-resident reuse path: provider.synced is already true from a prior
    // mount. Hocuspocus's `set synced` is a no-op when the value is unchanged
    // so a freshly-attached `'synced'` listener would never fire — without the
    // fast-path gate this would hang for the full 30s timeout.
    const p = track(makeProvider('warm-doc'));
    p.synced = true;
    const promise = syncPromise('warm-doc', p);
    await expect(promise).resolves.toBeUndefined();
    // Cache holds a settled sentinel so repeat calls return the same reference.
    expect(__syncPromiseCacheSize()).toBe(1);
    expect(__syncPromiseSettled('warm-doc')).toBe(true);
  });

  test('warm-path returns the same promise reference on repeat calls', () => {
    const p = track(makeProvider('warm-doc'));
    p.synced = true;
    const a = syncPromise('warm-doc', p);
    const b = syncPromise('warm-doc', p);
    // Stable reference is what makes React 19's `use()` short-circuit on
    // subsequent renders (after .status='fulfilled' has been set by React).
    expect(a).toBe(b);
  });

  test('resolves when provider fires synced', async () => {
    const p = track(makeProvider('doc1'));
    const promise = syncPromise('doc1', p);

    // Fire synced on next tick so await sees the pending → resolved transition
    queueMicrotask(() => p.emit('synced', { state: true }));

    await expect(promise).resolves.toBeUndefined();
    // Entry stays in cache after resolve so subsequent calls return the same
    // resolved promise (warm-path stability).
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
    // Cache persists settled entries so React's `use()` sees the same
    // .status='fulfilled' thenable across re-renders without a Suspense cycle.
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
    // Rejected entry stays in cache so subsequent renders see the same
    // .status='rejected' thenable — React's `use()` re-throws without
    // creating a fresh warm-path resolved promise that would mask the error.
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

    // Close after settle — no-op, must not throw
    p.emit('close', { event: { code: 1000, reason: 'normal', wasClean: true } });
    expect(__syncPromiseSettled('doc1')).toBe(true);
  });
});

describe('syncPromise timeout', () => {
  test('rejects with SyncTimeoutError after 30s elapsed', async () => {
    const p = track(makeProvider('slow-doc'));
    const origSetTimeout = globalThis.setTimeout;
    // Monkey-patch setTimeout for this test to capture + fast-fire the 30s timer
    let capturedTimer: (() => void) | null = null;
    // @ts-expect-error — intentional override for test
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      if (ms === getSyncTimeoutMs()) {
        capturedTimer = fn;
        // Return a dummy handle that clearTimeout can accept
        return { __dummy: true } as unknown as ReturnType<typeof origSetTimeout>;
      }
      return origSetTimeout(fn, ms);
    }) as typeof globalThis.setTimeout;

    try {
      const promise = syncPromise('slow-doc', p);
      expect(capturedTimer).not.toBeNull();
      // Fire the captured timer manually to simulate 30s elapsing
      capturedTimer?.();
      await expect(promise).rejects.toBeInstanceOf(SyncTimeoutError);
      // Rejected entry stays in cache (settled sentinel).
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

    // The original promise is orphaned — it neither resolves nor rejects.
    // Verify with Promise.race against a short delay.
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

    // Repeat call returns SAME rejected promise (boundary keeps catching)
    expect(syncPromise('doc1', p)).toBe(first);

    // Explicit invalidate (e.g. retry button) → next call gets fresh promise
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

    // Fire synced — listeners should have been detached, so orphaned stays pending
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
    // Models the React re-render after rejection: DocumentBoundary's `use()`
    // sees the same rejected promise and re-throws synchronously, letting
    // DocumentErrorBoundary render its fallback. Without persistence, a fresh
    // syncPromise call would warm-path-resolve on the broken provider and
    // mask the error.
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

    // Second reject is a no-op
    const ok = rejectSyncPromise('doc1', new BridgeSetupError('doc1'));
    expect(ok).toBe(false);
  });
});

describe('syncPromiseHasResolved (warm-reopen overlay gate)', () => {
  // EditorArea's deferred-value skeleton overlay reads this helper to skip
  // the overlay when both promises have resolved entries. Distinct from the
  // test-only `__syncPromiseSettled` because rejected entries are settled
  // but their consumers will throw to error boundary, not short-circuit.

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
    // Fire synced — listener resolves and flips resolved=true.
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
  // Locks in the production default for `SYNC_TIMEOUT_MS`. The e2e suite
  // drives the dial down to ~2s via `window.__okPerfOverrides` to exercise
  // the real `setTimeout` callback without a 30s wall-clock wait — that
  // override is only safe because this assertion catches accidental drift
  // in the production constant.
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
    // Arm should be consumed (one-shot semantics).
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
    // Even when provider.synced=true (which would normally short-circuit to
    // a resolved promise), an armed rejection must win so the error boundary
    // surfaces. This is load-bearing where the nav target's provider
    // may have been warm from a prior test step.
    const p = track(makeProvider('doc-armed-warm'));
    p.synced = true;
    __test_armPendingRejection('doc-armed-warm', 'timeout');
    const promise = syncPromise('doc-armed-warm', p);
    await expect(promise).rejects.toBeInstanceOf(SyncTimeoutError);
  });

  test('is one-shot: second syncPromise call returns the cached rejected promise', async () => {
    const p = track(makeProvider('doc-armed-once'));
    __test_armPendingRejection('doc-armed-once', 'timeout');

    // First call consumes the arm → rejected promise cached.
    const first = syncPromise('doc-armed-once', p);
    await expect(first).rejects.toBeInstanceOf(SyncTimeoutError);

    // Second call returns the SAME cached (rejected) promise — the arm was
    // one-shot and the rejected entry persists for React `use()` stability
    // (re-throwing synchronously across boundary re-renders).
    const second = syncPromise('doc-armed-once', p);
    expect(second).toBe(first);

    // Arm is consumed — `__test_clearArmedRejection` should see nothing to clear.
    expect(__test_clearArmedRejection('doc-armed-once')).toBe(false);
  });

  test('arm is consumed on creation, so a fresh syncPromise after invalidate is NOT armed', async () => {
    // Arm + create consumes the arm on the first call. After invalidate, a
    // new syncPromise call MUST follow the normal pending path — proven by
    // checking the entry is not settled before any async event fires.
    const p = track(makeProvider('doc-consumed-arm'));
    __test_armPendingRejection('doc-consumed-arm', 'timeout');
    const first = syncPromise('doc-consumed-arm', p);
    await expect(first).rejects.toBeInstanceOf(SyncTimeoutError);

    invalidateSyncPromise('doc-consumed-arm');
    // Arm is one-shot; the invalidate + fresh-create sequence starts with no arm.
    expect(__test_clearArmedRejection('doc-consumed-arm')).toBe(false);

    // A fresh syncPromise does NOT synchronously reject (the rejection would
    // only come from the real provider lifecycle, not the consumed arm).
    // Snapshot the settled-state BEFORE any async tick so the WS close path
    // cannot mutate it.
    const fresh = syncPromise('doc-consumed-arm', p);
    expect(__syncPromiseSettled('doc-consumed-arm')).toBe(false);
    // Prevent unhandled rejection noise from the provider's eventual close.
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
  /**
   * Browser background-tab throttling can stretch the 30s `setTimeout`
   * indefinitely, so the visibility-change handler is the deterministic
   * safety net. The handler itself is a thin DOM-gated wrapper around
   * `__reapTimedOutEntries(now)` — the pure helper we test here. The
   * wrapper is verified indirectly via the Playwright suite which runs in
   * a real browser.
   */
  test('rejects pending entry when elapsed wall-clock time exceeds timeout', async () => {
    const p = track(makeProvider('sleepy-doc'));
    const promise = syncPromise('sleepy-doc', p);
    const settled = promise.catch((e: unknown) => e);

    const createdAt = Date.now();
    // Simulate "user tabbed back after a 60s tab-sleep" — wall-clock now is
    // past the 30s timeout for this entry.
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

    // Even far in the future, the settled entry stays settled — no double-reject.
    const rejected = __reapTimedOutEntries(Date.now() + getSyncTimeoutMs() * 2);

    expect(rejected).toBe(0);
    expect(__syncPromiseSettled('synced-doc')).toBe(true);
  });
});

describe('mountId payload (US-006 / FR5 / AC13 — cross-namespace correlation)', () => {
  // Mirrors the equivalent pin in mount-promise.test.ts for the mount
  // namespace. Every ok/sync/* mark must carry mountId so cross-namespace
  // correlation by deterministic ID (not timestamp window)
  // joins sync events with cache/mount/cold/typing for a given doc-mount
  // cycle. Without this pin, a future refactor that drops the mountId
  // threading from the sync namespace would silently break correlation —
  // observable only in production traces.

  test('every ok/sync/* mark carries the mountId from the registry (warm-path resolve)', async () => {
    const collector = getCollector();
    if (!collector) {
      // Collector inactive in this build — skip without failing.
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
      // Caller-supplied fields land in `properties` per the PerfMark schema.
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
  // The mark.histogram consumer at the resolve sites feeds the distribution
  // the convention-cap-graduation sweep drains via getHistogramSnapshot.
  // Bucket name is kebab-case (the mark-name regex rejects dots in the third
  // segment); the paired DevTools mark — emitted by mark.histogram itself —
  // carries {docName, mountId, durationMs} plus the warm flag on the warm
  // path so the sweep can separate cold-only samples.
  //
  // The existing `mark('ok/sync/resolve', ...)` emission is preserved
  // alongside; this test pins that both fire.

  beforeEach(() => {
    // Reset the collector inside this describe so histogram counts isolate
    // per test (the module-scoped collector accumulates across cases otherwise).
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
    // elapsed is wall-clock — bound the assertion loosely so the test stays
    // stable on a heavily-loaded CI runner (typical < 50ms; cap generously).
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
  // Without finalize on reject, the cold-mount root entry lazily created by
  // provider-pool's `emitColdMountChild` (or by a sibling span emission) stays
  // in the registry permanently — the entry holds a live Span and the Map key
  // are both leaked. These tests pin that every reject path settles the
  // cold-mount span tree symmetrically with the resolve path.
  //
  // The pre-emit pattern mirrors the production sequence: pool.open() emits
  // `ok.provider-pool.open` first (creating the cold-mount root), then sync
  // either resolves or rejects.

  beforeEach(() => {
    __resetColdMountSpans();
  });

  afterEach(() => {
    __resetColdMountSpans();
  });

  test('onClose pre-sync-disconnect path finalizes the cold-mount span', async () => {
    setMountId('reject-close', 'reject-close-mid');
    // Simulate provider-pool's prior emit lazily creating the cold-mount root.
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
