/**
 * Tests for ProviderPool — LRU eviction, active document protection,
 * capacity management, and lifecycle.
 *
 * These tests construct real HocuspocusProvider instances pointing at a
 * non-existent server. The providers will stay in 'connecting' state but
 * the pool's LRU logic, Map management, and eviction ordering are all
 * exercised without needing a running Hocuspocus server.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { Compartment } from '@codemirror/state';
import { PROTOCOL_VERSION } from '@inkeep/open-knowledge-core';
import { parseHocuspocusAuthToken } from '@inkeep/open-knowledge-server';
import * as Y from 'yjs';
import { buildAuthToken } from '../lib/auth-token';
import { __resetCardinalityWarnings, getCollector } from '../lib/perf/collector';
import type { ClientPersistenceProvider } from './client-persistence';
import { ProviderPool } from './provider-pool';
import {
  __resetSyncPromiseCache,
  __syncPromiseCacheSize,
  BridgeSetupError,
  PreSyncDisconnectError,
  syncPromise,
} from './sync-promise';

function uniqueDocName(prefix = 'pp-us003'): string {
  return `${prefix}-${randomUUID()}`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await wait(10);
  }
  return predicate();
}

// Record-absent opens attach persistence through the asynchronous
// stored-state validation spine (the peek of the stored rows precedes the
// attach), so tests that pin post-attach behavior first await the attach.
// The end state they assert is unchanged from the pre-spine synchronous
// attach.
async function awaitAttachedPersistence(entry: {
  persistence: ClientPersistenceProvider | null;
}): Promise<ClientPersistenceProvider> {
  await waitFor(() => entry.persistence !== null, 2_000);
  const persistence = entry.persistence;
  if (persistence === null) throw new Error('expected persistence to attach');
  return persistence;
}

// Use a dummy URL — providers won't connect but pool logic still works
const DUMMY_WS = 'ws://localhost:1/collab';

// Persistence attaches only after a serverInstanceId is known
// (epoch-scoped IDB DB names). Tests that depend on `entry.persistence`
// being non-null must seed the live epoch before `pool.open()`.
const TEST_SERVER_INSTANCE_ID = 'test-server-instance';

let pool: ProviderPool;

afterEach(() => {
  pool?.dispose();
});

describe('ProviderPool basics', () => {
  test('starts empty with no active document', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    expect(pool.entries.size).toBe(0);
    expect(pool.getActive()).toBeNull();
    expect(pool.getActiveDocName()).toBeNull();
  });

  test('open() creates an entry and returns it', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open('doc1');
    expect(entry).not.toBeNull();
    expect(entry?.docName).toBe('doc1');
    expect(entry?.provider).toBeDefined();
    expect(pool.has('doc1')).toBe(true);
    expect(pool.entries.size).toBe(1);
  });

  test('open() reuses existing entry for same docName', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const entry1 = pool.open('doc1');
    const entry2 = pool.open('doc1');
    expect(entry1?.provider).toBe(entry2?.provider);
    expect(pool.entries.size).toBe(1);
  });

  test('setActive() sets the active document', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.open('doc1');
    pool.setActive('doc1');
    expect(pool.getActiveDocName()).toBe('doc1');
    expect(pool.getActive()?.docName).toBe('doc1');
  });

  test('setActive() throws for unopened document', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    expect(() => pool.setActive('nonexistent')).toThrow('is not open');
  });

  test('close() removes entry and clears active if it was active', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.open('doc1');
    pool.setActive('doc1');
    pool.close('doc1');
    expect(pool.has('doc1')).toBe(false);
    expect(pool.getActiveDocName()).toBeNull();
  });

  test('close() is no-op for unknown document', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.close('nonexistent'); // should not throw
    expect(pool.entries.size).toBe(0);
  });

  test('open() mints a fresh poolEventId on cold construct + emits hit:false', () => {
    getCollector()?.reset();
    __resetCardinalityWarnings();
    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open(uniqueDocName());
    expect(entry).not.toBeNull();
    expect(typeof entry?.poolEventId).toBe('string');
    expect(entry?.poolEventId.length).toBeGreaterThan(0);
    const c = getCollector();
    const counter = c?.counters['ok/pool/open'];
    expect(counter?.byProp.hit?.false).toBe(1);
    expect(counter?.byProp.hit?.true).toBeUndefined();
    const openMark = c?.marks
      .toArray()
      .find((m) => m.name === 'ok/pool/open' && m.properties?.docName === entry?.docName);
    expect(openMark?.properties?.hit).toBe(false);
    expect(openMark?.properties?.poolEventId).toBe(entry?.poolEventId);
  });

  test('open() warm-back emits hit:true with previous lastAccessedAt and stable poolEventId', async () => {
    getCollector()?.reset();
    pool = new ProviderPool(3, DUMMY_WS);
    const docName = uniqueDocName();
    const fresh = pool.open(docName);
    expect(fresh).not.toBeNull();
    const previousAccessedAt = fresh?.lastAccessedAt ?? 0;
    const stableId = fresh?.poolEventId ?? '';
    // Wait at least one ms so Date.now() ticks for the lastAccessedAt
    // assertion (warm-back updates the timestamp).
    await wait(2);
    const second = pool.open(docName);
    expect(second).toBe(fresh); // identity preserved
    expect(second?.poolEventId).toBe(stableId);
    expect((second?.lastAccessedAt ?? 0) >= previousAccessedAt).toBe(true);
    const c = getCollector();
    const counter = c?.counters['ok/pool/open'];
    // 1 cold + 1 warm.
    expect(counter?.byProp.hit?.false).toBe(1);
    expect(counter?.byProp.hit?.true).toBe(1);
    const hitMark = c?.marks
      .toArray()
      .find(
        (m) =>
          m.name === 'ok/pool/open' &&
          m.properties?.docName === docName &&
          m.properties?.hit === true,
      );
    expect(hitMark?.properties?.lastAccessedAt).toBe(previousAccessedAt);
    expect(hitMark?.properties?.poolEventId).toBe(stableId);
  });

  test('open() returns null and emits no marks for system docs', () => {
    getCollector()?.reset();
    pool = new ProviderPool(3, DUMMY_WS);
    const result = pool.open('__system__');
    expect(result).toBeNull();
    const c = getCollector();
    const openMarks = c?.marks.toArray().filter((m) => m.name === 'ok/pool/open') ?? [];
    expect(openMarks.length).toBe(0);
    expect(c?.counters['ok/pool/open']).toBeUndefined();
  });

  test('peek() returns the entry without affecting LRU or emitting marks', () => {
    getCollector()?.reset();
    pool = new ProviderPool(3, DUMMY_WS);
    const a = uniqueDocName();
    const b = uniqueDocName();
    pool.open(a);
    pool.open(b);
    const c = getCollector();
    const beforeMarks = c?.marks.length ?? 0;
    const peeked = pool.peek(a);
    expect(peeked).not.toBeNull();
    expect(peeked?.docName).toBe(a);
    // No new marks emitted.
    expect(c?.marks.length).toBe(beforeMarks);
    // peek() does NOT touch LRU — the next overflow eviction takes `a`
    // (oldest in [a, b]), not `b`. Capacity is 3, so opening one new
    // doc takes the pool to [a, b, new1]; opening another evicts `a`.
    pool.open(uniqueDocName());
    pool.open(uniqueDocName()); // overflow → evicts `a`
    expect(pool.has(a)).toBe(false);
    expect(pool.has(b)).toBe(true);
  });

  test('prewarm() inherits open()-path poolEventId mint', () => {
    getCollector()?.reset();
    pool = new ProviderPool(3, DUMMY_WS);
    const docName = uniqueDocName();
    const entry = pool.prewarm(docName);
    expect(entry).not.toBeNull();
    expect(typeof entry?.poolEventId).toBe('string');
    expect(entry?.poolEventId.length).toBeGreaterThan(0);
    const c = getCollector();
    // prewarm flowed through open() once → exactly one cold-emit.
    const counter = c?.counters['ok/pool/open'];
    expect(counter?.byProp.hit?.false).toBe(1);
  });

  test('has() returns false for unknown documents', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    expect(pool.has('nope')).toBe(false);
  });
});

describe('ProviderPool LRU eviction', () => {
  test('evicts LRU entry when at capacity', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.open('doc1');
    pool.open('doc2');
    pool.open('doc3');
    // Pool is full. Opening doc4 should evict doc1 (oldest).
    pool.open('doc4');
    expect(pool.has('doc1')).toBe(false);
    expect(pool.has('doc2')).toBe(true);
    expect(pool.has('doc3')).toBe(true);
    expect(pool.has('doc4')).toBe(true);
    expect(pool.entries.size).toBe(3);
  });

  test('never evicts the active document', () => {
    pool = new ProviderPool(2, DUMMY_WS);
    pool.open('doc1');
    pool.setActive('doc1');
    pool.open('doc2');
    // Pool is full (2). doc1 is active, doc2 is LRU.
    // Opening doc3 should evict doc2, not doc1.
    pool.open('doc3');
    expect(pool.has('doc1')).toBe(true); // active — protected
    expect(pool.has('doc2')).toBe(false); // evicted
    expect(pool.has('doc3')).toBe(true);
  });

  test('LRU order updates when document is re-opened', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.open('doc1');
    pool.open('doc2');
    pool.open('doc3');
    // Re-open doc1 — moves it to end of LRU (most recent)
    pool.open('doc1');
    // Opening doc4 should evict doc2 (now the LRU), not doc1
    pool.open('doc4');
    expect(pool.has('doc1')).toBe(true); // recently accessed
    expect(pool.has('doc2')).toBe(false); // evicted (was LRU)
    expect(pool.has('doc3')).toBe(true);
    expect(pool.has('doc4')).toBe(true);
  });

  test('LRU order updates when document is set active', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.open('doc1');
    pool.open('doc2');
    pool.open('doc3');
    // Set doc1 as active — moves it to end of LRU
    pool.setActive('doc1');
    pool.open('doc4');
    // doc2 should be evicted (LRU), not doc1 (active + recently touched)
    expect(pool.has('doc1')).toBe(true);
    expect(pool.has('doc2')).toBe(false);
  });

  test('eviction with capacity 1 and active doc', () => {
    pool = new ProviderPool(1, DUMMY_WS);
    pool.open('doc1');
    pool.setActive('doc1');
    // Pool is full (1) and the only entry is active.
    // Opening doc2 — cannot evict active doc1, so pool grows to 2.
    pool.open('doc2');
    // Both should exist since doc1 is protected
    expect(pool.has('doc1')).toBe(true);
    expect(pool.has('doc2')).toBe(true);
  });
});

describe('ProviderPool onChange', () => {
  test('fires onChange callback on open', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    let callCount = 0;
    pool.setOnChange(() => callCount++);
    pool.open('doc1');
    expect(callCount).toBeGreaterThan(0);
  });

  test('fires onChange on setActive', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.open('doc1');
    let callCount = 0;
    pool.setOnChange(() => callCount++);
    pool.setActive('doc1');
    expect(callCount).toBe(1);
  });

  test('fires onChange on close', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.open('doc1');
    let callCount = 0;
    pool.setOnChange(() => callCount++);
    pool.close('doc1');
    expect(callCount).toBeGreaterThan(0);
  });
});

describe('ProviderPool onEvict subscription', () => {
  // Replaces the explicit cross-module call to evictTiptapEditor /
  // evictCmEditor that lived in destroyEntry. Verifies that
  // the eviction event fires per docName for every entry-destroy path
  // (close, LRU evict, recycle, dispose) and that multiple subscribers
  // all run.
  test('fires evict listener on close', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.open('doc1');
    const evicted: string[] = [];
    pool.onEvict((name) => evicted.push(name));
    pool.close('doc1');
    expect(evicted).toEqual(['doc1']);
  });

  test('fires evict listener on LRU eviction', () => {
    pool = new ProviderPool(2, DUMMY_WS);
    pool.open('doc1');
    pool.open('doc2');
    pool.setActive('doc2'); // doc1 becomes LRU
    const evicted: string[] = [];
    pool.onEvict((name) => evicted.push(name));
    pool.open('doc3'); // triggers LRU eviction of doc1
    expect(evicted).toEqual(['doc1']);
  });

  test('fires evict listener on dispose for every entry', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.open('doc1');
    pool.open('doc2');
    pool.open('doc3');
    const evicted: string[] = [];
    pool.onEvict((name) => evicted.push(name));
    pool.dispose();
    expect(new Set(evicted)).toEqual(new Set(['doc1', 'doc2', 'doc3']));
  });

  test('multiple subscribers all fire', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.open('doc1');
    let count1 = 0;
    let count2 = 0;
    pool.onEvict(() => count1++);
    pool.onEvict(() => count2++);
    pool.close('doc1');
    expect(count1).toBe(1);
    expect(count2).toBe(1);
  });

  test('unsubscribe stops the listener', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.open('doc1');
    pool.open('doc2');
    let count = 0;
    const unsubscribe = pool.onEvict(() => count++);
    pool.close('doc1');
    expect(count).toBe(1);
    unsubscribe();
    pool.close('doc2');
    expect(count).toBe(1); // didn't increment after unsubscribe
  });

  test('a throwing listener does not prevent others from firing', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.open('doc1');
    let secondFired = false;
    pool.onEvict(() => {
      throw new Error('synthetic listener failure');
    });
    pool.onEvict(() => {
      secondFired = true;
    });
    // Suppress the warn so the test output stays clean.
    const originalWarn = console.warn;
    console.warn = mock(() => {});
    try {
      pool.close('doc1');
    } finally {
      console.warn = originalWarn;
    }
    expect(secondFired).toBe(true);
  });
});

describe('ProviderPool disconnect recycling', () => {
  test('does not recycle a provider that disconnects before first sync', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open('doc1');
    if (!entry) throw new Error('expected entry');
    pool.setActive('doc1');

    const originalProvider = entry.provider;
    originalProvider.emit('disconnect', {
      event: { code: 1006, reason: 'startup offline', wasClean: false },
    });

    expect(pool.getActive()?.provider).toBe(originalProvider);
  });

  test('recycles the active provider after disconnect when no unsynced changes remain', async () => {
    // Use recycleDebounceMs: 50 for fast test execution
    pool = new ProviderPool(3, DUMMY_WS, { recycleDebounceMs: 50 });
    const entry = pool.open('doc1');
    if (!entry) throw new Error('expected entry');
    pool.setActive('doc1');

    const originalProvider = entry.provider;
    originalProvider.emit('synced', { state: true });
    originalProvider.emit('disconnect', {
      event: { code: 1006, reason: 'server restart', wasClean: false },
    });

    // Recycle is debounced — entry still exists with a pending timer
    expect(entry.pendingRecycleTimer).not.toBeNull();

    // Wait for debounce to fire
    await wait(100);

    const recycled = pool.getActive();
    expect(recycled).not.toBeNull();
    expect(recycled?.provider).not.toBe(originalProvider);
    expect(recycled?.docName).toBe('doc1');
  });

  // MECHANISM-ONLY test.
  //
  // This test asserts the pool's internal behavior — "the provider reference is
  // preserved when unsynced local changes exist at disconnect time." It does
  // NOT check whether the resulting Y.Doc is correct after reconnect. Behavior-
  // level coverage (i.e. "does the document content survive a reconnect without
  // duplication or loss?") lives in
  // `packages/app/tests/integration/provider-pool-reconnect.test.ts` under the
  // unsynced-local-changes-during-disconnect/restart scenario.
  //
  // This disconnect-path "skip recycle on unsynced" is the active mechanism
  // for same-network-same-server blips. The authenticationFailed recycle is
  // the path that fires on server-instance mismatch, where client-side
  // buffer-and-replay (computeUnsyncedUpdate → clearData → recycle → replay)
  // carries unsynced edits across the new provider. The two paths compose.
  // A green mechanism test here is necessary-but-not-sufficient for the
  // behavior-level coverage.
  test('keeps the provider when disconnect occurs with unsynced local changes', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open('doc1');
    if (!entry) throw new Error('expected entry');
    pool.setActive('doc1');

    const originalProvider = entry.provider;
    originalProvider.emit('synced', { state: true });
    originalProvider.unsyncedChanges = 1;
    originalProvider.emit('disconnect', {
      event: { code: 1006, reason: 'offline', wasClean: false },
    });

    expect(pool.getActive()?.provider).toBe(originalProvider);
  });
});

describe('ProviderPool dispose', () => {
  test('dispose clears all entries and state', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.open('doc1');
    pool.open('doc2');
    pool.setActive('doc1');
    pool.dispose();
    expect(pool.entries.size).toBe(0);
    expect(pool.getActive()).toBeNull();
    expect(pool.getActiveDocName()).toBeNull();
  });
});

describe('ProviderPool setupObservers init-throw recovery (S4)', () => {
  // Instead of mock.module (which leaks to other test files in the same bun test
  // process), we sabotage the provider's Y.Doc to force a throw inside the onSynced
  // try block. Overriding doc.getXmlFragment to throw triggers the catch before
  // setupObservers is called — same code path, same recovery behavior.

  test('init-time throw rejects held syncPromise with BridgeSetupError + leaves entry pool-resident', async () => {
    pool = new ProviderPool(3, DUMMY_WS);

    const entry = pool.open('doc1');
    if (!entry) throw new Error('expected entry');
    pool.setActive('doc1');

    // Subscribe to the syncPromise BEFORE firing synced — this models the
    // DocumentBoundary use() consumer that must see the rejection. Without
    // a subscriber the rejectSyncPromise call would be a no-op (no cache entry).
    const consumerPromise = syncPromise('doc1', entry.provider);

    // Sabotage the provider's document to force a throw during observer init
    const doc = entry.provider.document;
    doc.getXmlFragment = () => {
      throw new Error('synthetic getXmlFragment failure');
    };

    // Silence the expected console.error so test output stays readable
    const errorSpy = mock(() => {});
    const origError = console.error;
    console.error = errorSpy;

    // Fire synced manually — this triggers onSynced → try block → throw → catch
    entry.provider.emit('synced', { state: true });

    console.error = origError;

    // Held syncPromise rejects with BridgeSetupError carrying the docName + cause.
    try {
      await consumerPromise;
      throw new Error('expected promise to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeSetupError);
      expect((err as BridgeSetupError).docName).toBe('doc1');
      expect((err as BridgeSetupError).cause).toBeInstanceOf(Error);
      expect(((err as BridgeSetupError).cause as Error).message).toContain(
        'synthetic getXmlFragment failure',
      );
    }

    // Entry stays pool-resident with bridgeSetupFailed flag — keeps activeProvider
    // non-null so EditorArea continues to render the boundary subtree, and the
    // user-driven recycle path (pool.recycle) can replace the broken provider.
    expect(pool.has('doc1')).toBe(true);
    expect(pool.entries.get('doc1')?.bridgeSetupFailed).toBe(true);
    expect(pool.getActiveDocName()).toBe('doc1');
    expect(pool.getActive()?.provider).toBe(entry.provider);

    // Error was logged via console.error with the expected prefix + full error object
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const loggedPrefix = errorSpy.mock.calls[0]?.[0] as string;
    const loggedError = errorSpy.mock.calls[0]?.[1] as Error;
    expect(loggedPrefix).toContain('[ProviderPool] setupObservers init failed for doc1:');
    expect(loggedError).toBeInstanceOf(Error);
    expect(loggedError.message).toContain('synthetic getXmlFragment failure');
  });

  test('pool.recycle on a bridge-setup-failed entry replaces it with a fresh provider', () => {
    pool = new ProviderPool(3, DUMMY_WS);

    const entry = pool.open('doc1');
    if (!entry) throw new Error('expected entry');
    pool.setActive('doc1');

    // Force a setup throw to mark the entry broken
    entry.provider.document.getXmlFragment = () => {
      throw new Error('synthetic init failure');
    };
    const errorSpy = mock(() => {});
    const origError = console.error;
    console.error = errorSpy;
    entry.provider.emit('synced', { state: true });
    console.error = origError;

    expect(pool.entries.get('doc1')?.bridgeSetupFailed).toBe(true);
    const brokenProvider = entry.provider;

    // Recycle — destroys broken entry and creates fresh one, preserving activeDocName
    pool.recycle('doc1');

    expect(pool.has('doc1')).toBe(true);
    expect(pool.getActiveDocName()).toBe('doc1');
    const newEntry = pool.entries.get('doc1');
    expect(newEntry).toBeDefined();
    expect(newEntry?.provider).not.toBe(brokenProvider);
    expect(newEntry?.bridgeSetupFailed).toBe(false);
  });

  test('non-active background doc disconnect triggers debounced destroy without re-open', async () => {
    // Use recycleDebounceMs: 50 for fast test execution
    pool = new ProviderPool(3, DUMMY_WS, { recycleDebounceMs: 50 });
    let onChangeCalls = 0;
    pool.setOnChange(() => onChangeCalls++);

    // Open two docs, only doc1 is active
    const entry1 = pool.open('doc1');
    if (!entry1) throw new Error('expected entry1');
    pool.setActive('doc1');
    const entry2 = pool.open('doc2');
    if (!entry2) throw new Error('expected entry2');
    onChangeCalls = 0;

    // Mark doc2 as synced with no unsynced changes
    entry2.provider.emit('synced', { state: true });
    entry2.provider.unsyncedChanges = 0;

    // Disconnect doc2 — schedules a debounced recycle
    entry2.provider.emit('disconnect', {
      event: { code: 1006, reason: 'server restart', wasClean: false },
    });

    // Immediately after disconnect, the recycle timer is pending — entry still exists
    expect(entry2.pendingRecycleTimer).not.toBeNull();
    expect(pool.has('doc2')).toBe(true);

    // Wait for the debounce to fire
    await wait(100);

    // Now doc2 is removed from the pool
    expect(pool.has('doc2')).toBe(false);

    // doc1 remains active and unaffected
    expect(pool.has('doc1')).toBe(true);
    expect(pool.getActiveDocName()).toBe('doc1');
    expect(pool.getActive()?.provider).toBe(entry1.provider);

    // Pool size decreased
    expect(pool.entries.size).toBe(1);

    // onChange was called (from notify() in the non-active branch)
    expect(onChangeCalls).toBeGreaterThanOrEqual(1);
  });

  // MECHANISM-ONLY test.
  //
  // This test asserts the debounce timer is cancelled when the provider
  // reconnects (emits `synced` before `RECYCLE_DEBOUNCE_MS` fires). It does
  // NOT check whether the resulting Y.Doc content is correct after reconnect.
  //
  // Behavior-level coverage of the same code path lives in
  // `packages/app/tests/integration/provider-pool-reconnect.test.ts` under
  // the fast-server-restart (<4s) scenario. The authenticationFailed recycle
  // fires on instance-ID mismatch even when this disconnect-path debounce is
  // cancelled, forcing the fresh Y.Doc that prevents duplication. This
  // mechanism test remains load-bearing for the same-server network-blip UX
  // — a green state here is necessary-but-not-sufficient for the behavior-
  // level coverage.
  test('recycle debounce is cancelled when provider reconnects (onSynced)', () => {
    pool = new ProviderPool(3, DUMMY_WS, { recycleDebounceMs: 200 });
    const entry = pool.open('doc1');
    if (!entry) throw new Error('expected entry');
    pool.setActive('doc1');

    // Pre-set observerCleanup so onSynced skips setupObservers (which would
    // throw on a dummy provider with no real server). We're testing the
    // debounce-cancel lifecycle, not the observer setup.
    entry.observerCleanup = () => {};

    // Simulate initial sync
    entry.hasSynced = true;
    entry.syncState = 'synced';
    entry.provider.unsyncedChanges = 0;

    // Disconnect — starts the debounce timer
    entry.provider.emit('disconnect', {
      event: { code: 1006, reason: 'server restart', wasClean: false },
    });
    expect(entry.pendingRecycleTimer).not.toBeNull();
    const _originalTimer = entry.pendingRecycleTimer;

    // Provider reconnects before the debounce fires — onSynced cancels the timer
    entry.provider.emit('synced', { state: true });
    expect(entry.pendingRecycleTimer).toBeNull();

    // Entry was NOT recycled — still in the pool, same object identity
    // (synchronous check, no need to wait — the timer was cleared)
    expect(pool.has('doc1')).toBe(true);
    expect(pool.getActive()?.provider).toBe(entry.provider);
    expect(entry.syncState).toBe('synced');
  });
});

describe('ProviderPool prewarm (V2 SPEC FR12 / Option G)', () => {
  test('prewarm admits a cold doc and returns its entry', () => {
    const pool = new ProviderPool(10, 'ws://localhost:9999');
    const entry = pool.prewarm('prewarm-doc');
    expect(entry).not.toBeNull();
    expect(pool.has('prewarm-doc')).toBe(true);
    pool.dispose();
  });

  test('prewarm places new entry at LRU-oldest — it is the first evicted', () => {
    const pool = new ProviderPool(3, 'ws://localhost:9999');
    // User-initiated opens — go to MRU (LRU-newest).
    pool.open('user-a');
    pool.open('user-b');
    pool.setActive('user-b'); // Pin active to prevent eviction

    // Prewarm should go to LRU-oldest.
    pool.prewarm('prewarm-c');
    expect(pool.has('prewarm-c')).toBe(true);

    // Next user-initiated open at capacity → should evict the prewarm first.
    pool.open('user-d');
    expect(pool.has('prewarm-c')).toBe(false);
    expect(pool.has('user-a')).toBe(true);
    expect(pool.has('user-b')).toBe(true);
    expect(pool.has('user-d')).toBe(true);
    pool.dispose();
  });

  test('prewarm is idempotent — re-prewarming an existing doc returns same entry', () => {
    const pool = new ProviderPool(10, 'ws://localhost:9999');
    const first = pool.prewarm('idempotent-doc');
    const second = pool.prewarm('idempotent-doc');
    expect(second).toBe(first);
    pool.dispose();
  });

  test('prewarm rejects system docs (__system__)', () => {
    const pool = new ProviderPool(10, 'ws://localhost:9999');
    const entry = pool.prewarm('__system__');
    expect(entry).toBeNull();
    expect(pool.has('__system__')).toBe(false);
    pool.dispose();
  });
});

describe('ProviderPool admission filter (__system__, DX7)', () => {
  test('open("__system__") returns null and does not add the pseudo-doc to the pool', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open('__system__');
    expect(entry).toBeNull();
    expect(pool.has('__system__')).toBe(false);
    expect(pool.entries.size).toBe(0);
  });

  test('open("__system__") does not fire onChange notification', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    let calls = 0;
    pool.setOnChange(() => calls++);
    pool.open('__system__');
    expect(calls).toBe(0);
  });

  test('non-system doc names are admitted normally', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    // Ensure a docName containing '__system__' as a substring is NOT filtered
    const entry = pool.open('my-__system__-notes');
    expect(entry).not.toBeNull();
    expect(pool.has('my-__system__-notes')).toBe(true);
  });
});

describe('ProviderPool HocuspocusProvider configuration (D8)', () => {
  test('new providers receive forceSyncInterval: 5000', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open('doc1');
    if (!entry) throw new Error('expected entry');
    // @hocuspocus/provider exposes the resolved configuration; the default
    // is `false`, so a set value confirms the pool passed the option through.
    expect(entry.provider.configuration.forceSyncInterval).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// MECHANISM-ONLY tests for `buildAuthToken` + `setExpectedServerInstanceId`.
//
// These tests assert the token-shape the pool will send to the server when
// `cachedServerInstanceId` is set vs. null. They do NOT verify that a
// stale-client reconnect after a server restart correctly recycles and
// produces a duplication-free Y.Doc — that end-to-end behavior is covered by
// the bug-class integration tests under `packages/app/tests/integration/`.
//
// "Green mechanism ≠ green feature": a passing buildAuthToken test
// here does NOT imply the server-restart-recovery fix is working. Trust the
// integration suite to judge behavior correctness.
// ---------------------------------------------------------------------------
describe('buildAuthToken (MECHANISM-ONLY — CRDT restart recovery + client version)', () => {
  // the token is now ALWAYS present (it carries the v1 client version
  // metadata) — even for an anonymous tab with no identity or instance claim.
  // It must still parse cleanly against the read-blind server schema, and an
  // absent principal must still fall through to SERVICE_WRITER attribution.
  test('always returns a token carrying client version metadata, even anonymous', () => {
    const token = buildAuthToken(null, null);
    const parsed = parseHocuspocusAuthToken(token);
    if (!parsed) throw new Error('expected valid token');
    expect(parsed.clientProtocolVersion).toBe(PROTOCOL_VERSION);
    expect(typeof parsed.clientRuntimeVersion).toBe('string');
    expect(parsed.clientKind).toBe('web');
    // No identity / no instance claim — server-side SERVICE_WRITER path intact.
    expect(parsed.principalId).toBeUndefined();
    expect(parsed.expectedServerInstanceId).toBeUndefined();
  });

  test('includes expectedServerInstanceId when the cache is set', () => {
    const tabId = { principalId: 'p-1', tabSessionId: 's-1' };
    const parsed = parseHocuspocusAuthToken(buildAuthToken(tabId, 'server-instance-abc'));
    if (!parsed) throw new Error('expected valid token');
    expect(parsed.principalId).toBe('p-1');
    expect(parsed.tabSessionId).toBe('s-1');
    expect(parsed.expectedServerInstanceId).toBe('server-instance-abc');
    // Version metadata rides alongside the identity claim.
    expect(parsed.clientKind).toBe('web');
  });

  test('omits expectedServerInstanceId when the cache is null', () => {
    const tabId = { principalId: 'p-1', tabSessionId: 's-1' };
    const parsed = parseHocuspocusAuthToken(buildAuthToken(tabId, null));
    if (!parsed) throw new Error('expected valid token');
    expect(parsed.expectedServerInstanceId).toBeUndefined();
    expect(parsed.principalId).toBe('p-1');
    expect(parsed.tabSessionId).toBe('s-1');
  });

  test('empty-string instance ID is treated as absent (not claimed)', () => {
    const tabId = { principalId: 'p-1', tabSessionId: 's-1' };
    const parsed = parseHocuspocusAuthToken(buildAuthToken(tabId, ''));
    if (!parsed) throw new Error('expected valid token');
    expect(parsed.expectedServerInstanceId).toBeUndefined();
  });

  test('instance-ID-only claim (no tab identity) still serializes cleanly', () => {
    const parsed = parseHocuspocusAuthToken(buildAuthToken(null, 'server-instance-abc'));
    if (!parsed) throw new Error('expected valid token');
    expect(parsed.expectedServerInstanceId).toBe('server-instance-abc');
    expect(parsed.principalId).toBeUndefined();
    expect(parsed.tabSessionId).toBeUndefined();
  });

  // expectedBranch — the cross-branch late-join backstop. Mirrors the
  // expectedServerInstanceId pattern: client carries the cached branch
  // in every connect token; server rejects on mismatch.
  test('includes expectedBranch when supplied', () => {
    const parsed = parseHocuspocusAuthToken(buildAuthToken(null, null, 'feature'));
    if (!parsed) throw new Error('expected valid token');
    expect(parsed.expectedBranch).toBe('feature');
  });

  test('omits expectedBranch when null or empty', () => {
    const tabId = { principalId: 'p-1', tabSessionId: 's-1' };
    expect(
      parseHocuspocusAuthToken(buildAuthToken(tabId, 'sid-x', null))?.expectedBranch,
    ).toBeUndefined();
    expect(
      parseHocuspocusAuthToken(buildAuthToken(tabId, 'sid-x', ''))?.expectedBranch,
    ).toBeUndefined();
  });

  // expectedDocLineageEpoch — the per-doc lineage fence, third axis of the
  // stale-client-persistence defense. Mirrors the expectedBranch cases.
  test('includes expectedDocLineageEpoch when supplied', () => {
    const parsed = parseHocuspocusAuthToken(buildAuthToken(null, 'sid-x', null, 'epoch-1'));
    if (!parsed) throw new Error('expected valid token');
    expect(parsed.expectedDocLineageEpoch).toBe('epoch-1');
  });

  test('omits expectedDocLineageEpoch when null or empty', () => {
    expect(
      parseHocuspocusAuthToken(buildAuthToken(null, 'sid-x', null, null))?.expectedDocLineageEpoch,
    ).toBeUndefined();
    expect(
      parseHocuspocusAuthToken(buildAuthToken(null, 'sid-x', null, ''))?.expectedDocLineageEpoch,
    ).toBeUndefined();
  });
});

describe('ProviderPool server-instance-ID claim (US-001)', () => {
  test('token serialized on open() reflects setExpectedServerInstanceId', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setTabIdentity({ principalId: 'p-1', tabSessionId: 's-1' });
    pool.setExpectedServerInstanceId('server-instance-xyz');

    const entry = pool.open('doc1');
    if (!entry) throw new Error('expected entry');
    // HocuspocusProvider resolves `token` lazily (it can be a string, a
    // function, or a Promise). The pool passes a string, so the resolved
    // configuration.token should be exactly the JSON we serialized.
    const resolved = entry.provider.configuration.token as unknown;
    expect(typeof resolved).toBe('string');
    const parsed = parseHocuspocusAuthToken(resolved as string);
    if (!parsed) throw new Error('expected valid token');
    expect(parsed.expectedServerInstanceId).toBe('server-instance-xyz');
    expect(parsed.principalId).toBe('p-1');
    expect(parsed.tabSessionId).toBe('s-1');
  });

  test('token omits expectedServerInstanceId when the cache is null', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setTabIdentity({ principalId: 'p-1', tabSessionId: 's-1' });
    // No setExpectedServerInstanceId call — cache stays null.

    const entry = pool.open('doc1');
    if (!entry) throw new Error('expected entry');
    const resolved = entry.provider.configuration.token as unknown;
    expect(typeof resolved).toBe('string');
    const parsed = parseHocuspocusAuthToken(resolved as string);
    if (!parsed) throw new Error('expected valid token');
    expect(parsed.expectedServerInstanceId).toBeUndefined();
  });

  test('setExpectedServerInstanceId(null) clears a previously-set cache', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setTabIdentity({ principalId: 'p-1', tabSessionId: 's-1' });
    pool.setExpectedServerInstanceId('server-instance-xyz');
    pool.setExpectedServerInstanceId(null);

    const entry = pool.open('doc1');
    if (!entry) throw new Error('expected entry');
    const resolved = entry.provider.configuration.token as unknown;
    const parsed = parseHocuspocusAuthToken(resolved as string);
    if (!parsed) throw new Error('expected valid token');
    expect(parsed.expectedServerInstanceId).toBeUndefined();
  });

  // Cross-branch late-join backstop. Mirrors the
  // setExpectedServerInstanceId → token.expectedServerInstanceId
  // wiring above. A pool that has observed a branch (via boot fetch
  // or CC1 server-info) carries it as `expectedBranch` on every open;
  // server rejects on mismatch with `reason: 'branch-mismatch'` —
  // tested server-side in standalone.test.ts and dispatched on the
  // client below.
  test('token serialized on open() reflects setObservedBranch', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setTabIdentity({ principalId: 'p-1', tabSessionId: 's-1' });
    pool.setObservedBranch('feature');

    const entry = pool.open('doc1');
    if (!entry) throw new Error('expected entry');
    const parsed = parseHocuspocusAuthToken(entry.provider.configuration.token as string);
    if (!parsed) throw new Error('expected valid token');
    expect(parsed.expectedBranch).toBe('feature');
  });

  test('branch-mismatch authenticationFailed invokes onBranchMismatch', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    let called = 0;
    pool.setOnBranchMismatch(() => {
      called++;
    });
    const entry = pool.open('doc1');
    if (!entry) throw new Error('expected entry');
    // Synthesize the rejection the server emits on branch mismatch.
    // `as unknown as { emit }` works around HocuspocusProvider's
    // protected emit — the suite already uses this pattern (see emit
    // sites earlier in this file).
    (entry.provider as unknown as { emit: (e: string, p: unknown) => void }).emit(
      'authenticationFailed',
      { reason: 'branch-mismatch' },
    );
    // The in-flight gate dispatches via `Promise.resolve().then(cb)`
    // (sync-throw-safe form) so the callback runs on the next
    // microtask. Yield once so the assertion sees the post-dispatch state.
    await Promise.resolve();
    expect(called).toBe(1);
  });

  test('branch-mismatch with no handler set is a clean no-op', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    // No setOnBranchMismatch call — handler is null.
    const entry = pool.open('doc1');
    if (!entry) throw new Error('expected entry');
    expect(() => {
      (entry.provider as unknown as { emit: (e: string, p: unknown) => void }).emit(
        'authenticationFailed',
        { reason: 'branch-mismatch' },
      );
    }).not.toThrow();
  });

  test('concurrent branch-mismatch rejections collapse to a single in-flight callback', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    let pending: (() => void) | null = null;
    let called = 0;
    pool.setOnBranchMismatch(
      () =>
        new Promise<void>((resolve) => {
          called++;
          pending = () => resolve();
        }),
    );
    const e1 = pool.open('doc1');
    const e2 = pool.open('doc2');
    if (!e1 || !e2) throw new Error('expected entries');

    const emit = (entry: typeof e1) => {
      (entry.provider as unknown as { emit: (e: string, p: unknown) => void }).emit(
        'authenticationFailed',
        { reason: 'branch-mismatch' },
      );
    };
    emit(e1);
    emit(e2); // second dispatch while first is still in-flight
    // Yield so the first dispatch's microtask-deferred callback runs.
    await Promise.resolve();

    // Both providers fired authenticationFailed but only one callback
    // ran; the second was gated.
    expect(called).toBe(1);

    // Resolve the in-flight promise; subsequent dispatches should run
    // a fresh callback (the gate self-clears on settle).
    if (pending !== null) (pending as () => void)();
    await wait(0);
    emit(e1);
    await Promise.resolve();
    expect(called).toBe(2);
  });

  // Regression: a callback that returns a real promise must hold the
  // gate across event-loop turns. The bug shape this guards against:
  // a `void`-fronted callback that kicks off async work but returns
  // `undefined` synchronously — the gate would clear on the next
  // microtask while the work is still in flight, allowing N cross-turn
  // mismatches to fan out into N callback invocations. The fix is the
  // type signature (`() => Promise<void>`) which forces callers to
  // surface their async chain through the return value.
  test('cross-turn branch-mismatch holds the gate while the callback promise is pending', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    let resolveWork: (() => void) | null = null;
    let called = 0;
    pool.setOnBranchMismatch(
      () =>
        new Promise<void>((resolve) => {
          called++;
          resolveWork = () => resolve();
        }),
    );
    const e1 = pool.open('doc1');
    const e2 = pool.open('doc2');
    if (!e1 || !e2) throw new Error('expected entries');
    const emit = (entry: typeof e1) => {
      (entry.provider as unknown as { emit: (e: string, p: unknown) => void }).emit(
        'authenticationFailed',
        { reason: 'branch-mismatch' },
      );
    };
    emit(e1);
    // Drain microtasks so the gate's `Promise.resolve().then(cb)` has
    // attached and `cb` has run. The bug shape: a void-returning `cb`
    // would leave the gate cleared at this point because the wrapping
    // `.then` resolved with `undefined`. With a Promise-returning `cb`,
    // the gate must still be held.
    await Promise.resolve();
    await Promise.resolve();
    emit(e2); // cross-turn second dispatch
    await Promise.resolve();
    expect(called).toBe(1);
    if (resolveWork !== null) (resolveWork as () => void)();
    await wait(0);
  });

  // localStorage-persistence path — load-bearing for the fresh-tab-with-
  // stale-IDB defense. Bun's `bun:test` env has no DOM globals, so the
  // pool's storage handle is parameterized via the constructor and we
  // pass a Map-backed stub here. Mirrors the DI pattern used by
  // `use-editor-mode.ts`.
  describe('observed-branch localStorage persistence', () => {
    function makeStubStorage(): {
      stub: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
      store: Map<string, string>;
    } {
      const store = new Map<string, string>();
      const stub = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
          store.set(k, v);
        },
        removeItem: (k: string) => {
          store.delete(k);
        },
      };
      return { stub, store };
    }

    test('setObservedBranch writes the value to storage', () => {
      const { stub, store } = makeStubStorage();
      pool = new ProviderPool(3, DUMMY_WS, { storage: stub });
      pool.setObservedBranch('feature');
      expect(store.get('ok-last-observed-branch')).toBe('feature');
    });

    test('cold pool with pre-seeded storage value claims that branch on first open()', () => {
      // The exact fresh-tab-with-stale-IDB regression guard — a session-1
      // tab persisted `main`, the user closes it, branch switches to
      // `feature`, the user opens a new tab. The first auth token must
      // carry `expectedBranch=main` so the server's onAuthenticate
      // rejects on mismatch and triggers the IDB-clearing recycle.
      const { stub, store } = makeStubStorage();
      store.set('ok-last-observed-branch', 'main');
      pool = new ProviderPool(3, DUMMY_WS, { storage: stub });
      const entry = pool.open('doc1');
      if (!entry) throw new Error('expected entry');
      const parsed = parseHocuspocusAuthToken(entry.provider.configuration.token as string);
      if (!parsed) throw new Error('expected valid token');
      expect(parsed.expectedBranch).toBe('main');
    });

    test('setObservedBranch with empty string clears the storage key', () => {
      const { stub, store } = makeStubStorage();
      store.set('ok-last-observed-branch', 'feature');
      pool = new ProviderPool(3, DUMMY_WS, { storage: stub });
      pool.setObservedBranch('');
      expect(store.has('ok-last-observed-branch')).toBe(false);
    });

    test('storage.setItem throw is non-fatal — in-memory cache still updates', () => {
      const throwingStub: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = {
        getItem: () => null,
        setItem: () => {
          throw new Error('synthetic quota error');
        },
        removeItem: () => {},
      };
      pool = new ProviderPool(3, DUMMY_WS, { storage: throwingStub });
      // Should not throw; observedBranch is still honored from the in-
      // memory cache even though localStorage failed.
      pool.setObservedBranch('feature');
      const entry = pool.open('doc1');
      if (!entry) throw new Error('expected entry');
      const parsed = parseHocuspocusAuthToken(entry.provider.configuration.token as string);
      if (!parsed) throw new Error('expected valid token');
      expect(parsed.expectedBranch).toBe('feature');
    });

    test('null storage (default in Node tests) — pool runs without persistence', () => {
      pool = new ProviderPool(3, DUMMY_WS, { storage: null });
      pool.setObservedBranch('feature');
      // Without storage there's no persistence, but the in-memory cache
      // still drives the auth-token claim for THIS pool instance.
      const entry = pool.open('doc1');
      if (!entry) throw new Error('expected entry');
      const parsed = parseHocuspocusAuthToken(entry.provider.configuration.token as string);
      if (!parsed) throw new Error('expected valid token');
      expect(parsed.expectedBranch).toBe('feature');
    });
  });

  // Auth-token claim sources `expectedServerInstanceId` from the live
  // in-memory `cachedServerInstanceId`. The DB-name shape
  // `ok-ydoc:${branch}:${serverInstanceId}:${docName}` carries the epoch
  // structurally, so no separate localStorage marker is consulted or
  // written.
  describe('server-instance-id auth-claim derivation', () => {
    test('open() carries the live server id as the auth-token claim', () => {
      pool = new ProviderPool(3, DUMMY_WS);
      pool.setExpectedServerInstanceId('server-current');
      const entry = pool.open('doc1');
      if (!entry) throw new Error('expected entry');
      const parsed = parseHocuspocusAuthToken(entry.provider.configuration.token as string);
      if (!parsed) throw new Error('expected valid token');
      expect(parsed.expectedServerInstanceId).toBe('server-current');
    });

    test('mismatch clears the cached id; next open() carries no claim', async () => {
      pool = new ProviderPool(3, DUMMY_WS);
      pool.setExpectedServerInstanceId('server-old');
      const entry = pool.open('doc1');
      if (!entry) throw new Error('expected entry');
      pool.setActive('doc1');
      entry.provider.emit('authenticationFailed', { reason: 'server-instance-mismatch' });
      await pool.awaitMismatchSettled();

      const next = pool.open('doc2');
      if (!next) throw new Error('expected next entry');
      const parsed = parseHocuspocusAuthToken(next.provider.configuration.token as string);
      expect(parsed?.expectedServerInstanceId).toBeUndefined();
    });

    test('null storage — pool runs without persistence', () => {
      pool = new ProviderPool(3, DUMMY_WS, { storage: null });
      pool.setExpectedServerInstanceId('server-instance-abc');
      const entry = pool.open('doc1');
      if (!entry) throw new Error('expected entry');
      const parsed = parseHocuspocusAuthToken(entry.provider.configuration.token as string);
      if (!parsed) throw new Error('expected valid token');
      expect(parsed.expectedServerInstanceId).toBe('server-instance-abc');
    });
  });

  test('setExpectedServerInstanceId affects future opens, not existing providers', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setTabIdentity({ principalId: 'p-1', tabSessionId: 's-1' });

    // Open BEFORE setting the instance ID — first provider has no claim.
    const entry1 = pool.open('doc1');
    if (!entry1) throw new Error('expected entry1');

    pool.setExpectedServerInstanceId('server-instance-xyz');

    // Open AFTER — second provider carries the claim.
    const entry2 = pool.open('doc2');
    if (!entry2) throw new Error('expected entry2');

    const tok1 = parseHocuspocusAuthToken(entry1.provider.configuration.token as string);
    const tok2 = parseHocuspocusAuthToken(entry2.provider.configuration.token as string);
    if (!tok1 || !tok2) throw new Error('expected valid tokens');
    expect(tok1.expectedServerInstanceId).toBeUndefined();
    expect(tok2.expectedServerInstanceId).toBe('server-instance-xyz');
  });
});

// ---------------------------------------------------------------------------
// MECHANISM-ONLY tests for the per-doc lineage-epoch records (the doc-lineage
// fence's client half): claim derivation, envelope validation, record/drop
// round-trips through the constructor's storage seam. They do NOT verify that
// a stale rejoin produces a duplication-free Y.Doc — that end-to-end behavior
// is covered by tests/integration/stale-idb-doc-reload.test.ts and
// tests/integration/stale-idb-lineage-doors.test.ts.
// ---------------------------------------------------------------------------
describe('ProviderPool doc-lineage epoch records', () => {
  const ENVELOPE_KEY = 'ok-doc-lineage-epochs';

  function makeStubStorage(): {
    stub: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
    store: Map<string, string>;
  } {
    const store = new Map<string, string>();
    const stub = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    };
    return { stub, store };
  }

  function makePersistenceStub(): ClientPersistenceProvider {
    return {
      whenSynced: Promise.resolve(undefined as never),
      synced: true,
      destroy: async () => {},
      clearData: async () => {},
      flushFullState: async () => {},
    } as unknown as ClientPersistenceProvider;
  }

  function makeEnvelope(
    serverInstanceId: string,
    epochs: Record<string, string>,
    // `_unknown_` mirrors UNKNOWN_BRANCH_SENTINEL — the scope a pool that
    // never observed a branch writes/validates against.
    branch = '_unknown_',
  ): string {
    return JSON.stringify({ branch, serverInstanceId, epochs });
  }

  function tokenOf(entry: { provider: { configuration: { token: unknown } } }) {
    const parsed = parseHocuspocusAuthToken(entry.provider.configuration.token as string);
    if (!parsed) throw new Error('expected valid token');
    return parsed;
  }

  test('open() claims the epoch recorded in a valid storage envelope', () => {
    const { stub, store } = makeStubStorage();
    store.set(ENVELOPE_KEY, makeEnvelope(TEST_SERVER_INSTANCE_ID, { doc1: 'epoch-1' }));
    pool = new ProviderPool(3, DUMMY_WS, {
      storage: stub,
      persistenceFactory: mock(makePersistenceStub),
    });
    pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
    const entry = pool.open('doc1');
    if (!entry) throw new Error('expected entry');
    expect(tokenOf(entry).expectedDocLineageEpoch).toBe('epoch-1');
  });

  test('claim is omitted while the server instance id is unknown', () => {
    const { stub, store } = makeStubStorage();
    store.set(ENVELOPE_KEY, makeEnvelope(TEST_SERVER_INSTANCE_ID, { doc1: 'epoch-1' }));
    pool = new ProviderPool(3, DUMMY_WS, {
      storage: stub,
      persistenceFactory: mock(makePersistenceStub),
    });
    // No setExpectedServerInstanceId — the envelope cannot be validated, and
    // a lineage claim must never race the instance-unknown boot window.
    const entry = pool.open('doc1');
    if (!entry) throw new Error('expected entry');
    expect(tokenOf(entry).expectedDocLineageEpoch).toBeUndefined();
  });

  test('envelope from a different server instance is ignored', () => {
    const { stub, store } = makeStubStorage();
    store.set(ENVELOPE_KEY, makeEnvelope('dead-instance', { doc1: 'epoch-1' }));
    pool = new ProviderPool(3, DUMMY_WS, {
      storage: stub,
      persistenceFactory: mock(makePersistenceStub),
    });
    pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
    const entry = pool.open('doc1');
    if (!entry) throw new Error('expected entry');
    expect(tokenOf(entry).expectedDocLineageEpoch).toBeUndefined();
  });

  test('envelope from a different branch scope is ignored', () => {
    const { stub, store } = makeStubStorage();
    store.set(ENVELOPE_KEY, makeEnvelope(TEST_SERVER_INSTANCE_ID, { doc1: 'epoch-1' }, 'feature'));
    pool = new ProviderPool(3, DUMMY_WS, {
      storage: stub,
      persistenceFactory: mock(makePersistenceStub),
    });
    // Pool never observes a branch — its scope normalizes to `_unknown_`,
    // which must not consume a `feature`-scoped envelope.
    pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
    const entry = pool.open('doc1');
    if (!entry) throw new Error('expected entry');
    expect(tokenOf(entry).expectedDocLineageEpoch).toBeUndefined();
  });

  test('synced lifecycle epoch is recorded and round-trips into a fresh pool', () => {
    const { stub, store } = makeStubStorage();
    pool = new ProviderPool(3, DUMMY_WS, {
      storage: stub,
      persistenceFactory: mock(makePersistenceStub),
    });
    pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
    const docName = uniqueDocName('pp-lineage-record');
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');

    // Simulate the server-minted epoch arriving in-band, then the sync event.
    entry.provider.document.getMap('lifecycle').set('epoch', 'epoch-live');
    entry.provider.emit('synced', { state: true });

    const raw = store.get(ENVELOPE_KEY);
    if (raw === undefined) throw new Error('expected envelope written to storage');
    const envelope = JSON.parse(raw) as {
      branch: string;
      serverInstanceId: string;
      epochs: Record<string, string>;
    };
    expect(envelope.serverInstanceId).toBe(TEST_SERVER_INSTANCE_ID);
    expect(envelope.epochs[docName]).toBe('epoch-live');

    // A fresh pool over the same storage (new tab) claims the epoch.
    const pool2 = new ProviderPool(3, DUMMY_WS, {
      storage: stub,
      persistenceFactory: mock(makePersistenceStub),
    });
    try {
      pool2.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
      const entry2 = pool2.open(docName);
      if (!entry2) throw new Error('expected entry2');
      expect(tokenOf(entry2).expectedDocLineageEpoch).toBe('epoch-live');
    } finally {
      pool2.dispose();
    }
  });

  test('doc-lineage-mismatch rejection drops the record and reopens claim-less', async () => {
    const { stub, store } = makeStubStorage();
    const docName = uniqueDocName('pp-lineage-reject');
    store.set(ENVELOPE_KEY, makeEnvelope(TEST_SERVER_INSTANCE_ID, { [docName]: 'epoch-dead' }));
    pool = new ProviderPool(3, DUMMY_WS, {
      storage: stub,
      persistenceFactory: mock(makePersistenceStub),
    });
    pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    pool.setActive(docName);
    expect(tokenOf(entry).expectedDocLineageEpoch).toBe('epoch-dead');

    // Silence the expected structured recovery warn.
    const warnSpy = mock(() => {});
    const origWarn = console.warn;
    console.warn = warnSpy;
    entry.provider.emit('authenticationFailed', { reason: 'doc-lineage-mismatch' });
    console.warn = origWarn;

    // The arm runs synchronously: record dropped, stale entry replaced by a
    // claim-less reopen, active doc preserved.
    const reopened = pool.peek(docName);
    if (!reopened) throw new Error('expected reopened entry');
    expect(reopened).not.toBe(entry);
    expect(pool.getActiveDocName()).toBe(docName);
    expect(tokenOf(reopened).expectedDocLineageEpoch).toBeUndefined();

    const raw = store.get(ENVELOPE_KEY);
    if (raw === undefined) throw new Error('expected envelope still present');
    const envelope = JSON.parse(raw) as { epochs: Record<string, string> };
    expect(envelope.epochs[docName]).toBeUndefined();

    const emitted = warnSpy.mock.calls
      .map((call) => call[0] as string)
      .filter((line) => typeof line === 'string' && line.includes('ok-doc-lineage-mismatch'));
    expect(emitted.length).toBe(1);
    const event = JSON.parse(emitted[0] ?? '{}') as Record<string, string>;
    expect(event.via).toBe('auth-rejection');
    expect(event.staleEpoch).toBe('epoch-dead');

    // Let the in-flight clear settle so dispose() in afterEach is clean.
    await wait(10);
  });

  test('deferred-attach guard replaces a stale-lineage entry instead of hydrating it', async () => {
    const { stub } = makeStubStorage();
    pool = new ProviderPool(3, DUMMY_WS, {
      storage: stub,
      persistenceFactory: mock(makePersistenceStub),
    });
    const docName = uniqueDocName('pp-lineage-deferred');

    // Sync once while the instance id is unknown — records the (soon dead)
    // epoch in-memory; the envelope write is skipped (no instance id yet).
    const first = pool.open(docName);
    if (!first) throw new Error('expected first entry');
    first.provider.document.getMap('lifecycle').set('epoch', 'epoch-dead');
    first.provider.emit('synced', { state: true });
    pool.close(docName);

    // Reopen (instance still unknown): the open-time snapshot is
    // 'epoch-dead' and persistence stays deferred. The entry then syncs the
    // re-seeded doc's fresh epoch, which re-records over the dead record —
    // the exact state where a guard comparing against the map's CURRENT
    // value (instead of the snapshot) would no-op.
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    expect(entry.persistence).toBeNull();
    entry.provider.document.getMap('lifecycle').set('epoch', 'epoch-live');
    entry.provider.emit('synced', { state: true });

    const warnSpy = mock(() => {});
    const origWarn = console.warn;
    console.warn = warnSpy;
    // Learning the instance id triggers the deferred attach, whose guard
    // routes this entry through close → clear → reopen instead of attaching.
    pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
    console.warn = origWarn;

    const reopened = pool.peek(docName);
    if (!reopened) throw new Error('expected reopened entry');
    expect(reopened).not.toBe(entry);
    // Unlike the auth-rejection recovery, the record is NOT dropped here —
    // the entry's own sync already re-recorded the fresh epoch (it describes
    // the live doc), so the replacement claims it.
    expect(tokenOf(reopened).expectedDocLineageEpoch).toBe('epoch-live');
    // The replacement entry's open-time snapshot is the re-recorded fresh
    // epoch — it opened after the original entry's sync wrote 'epoch-live'
    // into the record map, so its own deferred-attach guard would see a
    // matching live epoch on a later attach.
    expect(reopened.lineageEpochRecordAtOpen).toBe('epoch-live');

    const emitted = warnSpy.mock.calls
      .map((call) => call[0] as string)
      .filter((line) => typeof line === 'string' && line.includes('ok-doc-lineage-mismatch'));
    expect(emitted.length).toBe(1);
    const event = JSON.parse(emitted[0] ?? '{}') as Record<string, string>;
    expect(event.via).toBe('deferred-attach');
    expect(event.staleEpoch).toBe('epoch-dead');
    expect(event.liveEpoch).toBe('epoch-live');

    // Let the in-flight clear settle so dispose() in afterEach is clean.
    await wait(10);
  });

  test('rename-redirect and doc-deleted rejections prune the lineage record', () => {
    const { stub, store } = makeStubStorage();
    const renamedDoc = uniqueDocName('pp-lineage-renamed');
    const deletedDoc = uniqueDocName('pp-lineage-deleted');
    store.set(
      ENVELOPE_KEY,
      makeEnvelope(TEST_SERVER_INSTANCE_ID, {
        [renamedDoc]: 'epoch-a',
        [deletedDoc]: 'epoch-b',
      }),
    );
    pool = new ProviderPool(3, DUMMY_WS, {
      storage: stub,
      persistenceFactory: mock(makePersistenceStub),
    });
    pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
    const renamedEntry = pool.open(renamedDoc);
    const deletedEntry = pool.open(deletedDoc);
    if (!renamedEntry || !deletedEntry) throw new Error('expected entries');

    renamedEntry.provider.emit('authenticationFailed', {
      reason: `rename-redirect:${renamedDoc}-new`,
    });
    deletedEntry.provider.emit('authenticationFailed', { reason: 'doc-deleted' });

    const raw = store.get(ENVELOPE_KEY);
    if (raw === undefined) throw new Error('expected envelope still present');
    const envelope = JSON.parse(raw) as { epochs: Record<string, string> };
    expect(envelope.epochs[renamedDoc]).toBeUndefined();
    expect(envelope.epochs[deletedDoc]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// MECHANISM-ONLY tests for the stored-state validation spine — the in-band
// fence over the record-absent attach population (boot-window snapshot,
// evicted envelope, pre-epoch profile). The peek and persistence factory are
// both injected; the end-to-end no-corruption contract lives in
// tests/integration/stale-idb-lineage-record-absent-doors.test.ts.
// ---------------------------------------------------------------------------
describe('ProviderPool stored-state validation spine', () => {
  function makePersistenceStub(): ClientPersistenceProvider {
    return {
      whenSynced: Promise.resolve(undefined as never),
      synced: true,
      destroy: async () => {},
      clearData: async () => {},
      flushFullState: async () => {},
    } as unknown as ClientPersistenceProvider;
  }

  function captureWarns(): {
    lines: () => string[];
    restore: () => void;
    spy: ReturnType<typeof spyOn>;
  } {
    const spy = spyOn(console, 'warn').mockImplementation(() => undefined);
    return {
      lines: () =>
        spy.mock.calls
          .map((call) => call[0])
          .filter((first): first is string => typeof first === 'string'),
      restore: () => spy.mockRestore(),
      spy,
    };
  }

  test('refuses stored rows whose in-band epoch differs from the live lineage', async () => {
    const warns = captureWarns();
    try {
      const peek = mock(async () => 'epoch-dead');
      pool = new ProviderPool(3, DUMMY_WS, {
        storage: null,
        persistenceFactory: mock(makePersistenceStub),
        peekStoredLineageEpoch: peek,
      });
      pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
      const docName = uniqueDocName('pp-spine-refuse');
      const entry = pool.open(docName);
      if (!entry) throw new Error('expected entry');
      pool.setActive(docName);
      expect(entry.persistence).toBeNull();

      // The live doc syncs a fresh lineage; the spine's truth table sees
      // stored 'epoch-dead' ≠ live 'epoch-live' and refuses.
      entry.provider.document.getMap('lifecycle').set('epoch', 'epoch-live');
      entry.provider.emit('synced', { state: true });

      const replaced = await waitFor(
        () => pool.peek(docName) !== null && pool.peek(docName) !== entry,
        2_000,
      );
      expect(replaced).toBe(true);
      expect(pool.getActiveDocName()).toBe(docName);

      const emitted = warns.lines().filter((line) => line.includes('ok-doc-lineage-mismatch'));
      expect(emitted.length).toBe(1);
      const event = JSON.parse(emitted[0] ?? '{}') as Record<string, string>;
      expect(event.via).toBe('stored-state-validation');
      expect(event.staleEpoch).toBe('epoch-dead');
      expect(event.liveEpoch).toBe('epoch-live');
      expect(event.docName).toBe(docName);

      // Let the in-flight clear settle so dispose() in afterEach is clean.
      await wait(10);
    } finally {
      warns.restore();
    }
  });

  test('refuses stored epoch-bearing rows when the live doc carries no epoch post-sync', async () => {
    const warns = captureWarns();
    try {
      const peek = mock(async () => 'epoch-dead');
      pool = new ProviderPool(3, DUMMY_WS, {
        storage: null,
        persistenceFactory: mock(makePersistenceStub),
        peekStoredLineageEpoch: peek,
      });
      pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
      const docName = uniqueDocName('pp-spine-live-absent');
      const entry = pool.open(docName);
      if (!entry) throw new Error('expected entry');

      // Sync delivers no lifecycle epoch (pre-epoch server): the stored
      // rows' provenance cannot be confirmed against the live lineage.
      entry.provider.emit('synced', { state: true });

      const replaced = await waitFor(
        () => pool.peek(docName) !== null && pool.peek(docName) !== entry,
        2_000,
      );
      expect(replaced).toBe(true);

      const emitted = warns.lines().filter((line) => line.includes('ok-doc-lineage-mismatch'));
      expect(emitted.length).toBe(1);
      const event = JSON.parse(emitted[0] ?? '{}') as Record<string, string>;
      expect(event.via).toBe('stored-state-validation');
      expect(event.staleEpoch).toBe('epoch-dead');
      expect(event.liveEpoch).toBe('<absent>');

      await wait(10);
    } finally {
      warns.restore();
    }
  });

  test('attaches when the stored epoch matches the live lineage, then backfills the cache', async () => {
    const flushSpy = mock(async () => {});
    const persistenceFactory = mock(
      () =>
        ({
          whenSynced: Promise.resolve(undefined as never),
          synced: true,
          destroy: async () => {},
          clearData: async () => {},
          flushFullState: flushSpy,
        }) as unknown as ClientPersistenceProvider,
    );
    const peek = mock(async () => 'epoch-live');
    pool = new ProviderPool(3, DUMMY_WS, {
      storage: null,
      persistenceFactory,
      peekStoredLineageEpoch: peek,
    });
    pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
    const docName = uniqueDocName('pp-spine-match');
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    entry.provider.document.getMap('lifecycle').set('epoch', 'epoch-live');
    entry.provider.emit('synced', { state: true });

    await awaitAttachedPersistence(entry);
    expect(persistenceFactory).toHaveBeenCalledTimes(1);
    // Post-sync attach: the rows' watermark predates the live state, so the
    // spine schedules the full-state backfill.
    const flushed = await waitFor(() => flushSpy.mock.calls.length === 1, 2_000);
    expect(flushed).toBe(true);
  });

  test('attaches immediately when the stored rows carry nothing to validate (null peek)', async () => {
    const persistenceFactory = mock(makePersistenceStub);
    const peek = mock(async () => null);
    pool = new ProviderPool(3, DUMMY_WS, {
      storage: null,
      persistenceFactory,
      peekStoredLineageEpoch: peek,
    });
    pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
    const docName = uniqueDocName('pp-spine-null');
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');

    // No sync needed: the fast path covers first-ever opens and post-clear
    // reattaches without waiting for server contact on the live doc.
    await awaitAttachedPersistence(entry);
    expect(entry.hasSynced).toBe(false);
    expect(persistenceFactory).toHaveBeenCalledTimes(1);
  });

  test('record-present entry that has not synced waits for sync before validating', async () => {
    const persistenceFactory = mock(makePersistenceStub);
    const peek = mock(async () => 'epoch-x');
    pool = new ProviderPool(3, DUMMY_WS, {
      storage: null,
      persistenceFactory,
      peekStoredLineageEpoch: peek,
    });
    const docName = uniqueDocName('pp-spine-wait');

    // Record 'epoch-x' in-memory while the instance id is unknown, then
    // reopen so the open-time snapshot carries the record but the entry has
    // not synced — the population the record-present guard arm cannot
    // evaluate (it requires hasSynced).
    const first = pool.open(docName);
    if (!first) throw new Error('expected first entry');
    first.provider.document.getMap('lifecycle').set('epoch', 'epoch-x');
    first.provider.emit('synced', { state: true });
    pool.close(docName);

    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    expect(entry.lineageEpochRecordAtOpen).toBe('epoch-x');
    expect(entry.hasSynced).toBe(false);

    pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);

    // The spine holds the attach while the live epoch is untrustworthy.
    await wait(50);
    expect(entry.persistence).toBeNull();

    // First sync lands the matching lineage — the held attach proceeds.
    entry.provider.document.getMap('lifecycle').set('epoch', 'epoch-x');
    entry.provider.emit('synced', { state: true });
    await awaitAttachedPersistence(entry);
    expect(persistenceFactory).toHaveBeenCalledTimes(1);
  });

  test('a re-dispatch onto an entry with an in-flight spine run is a no-op (attach ownership)', async () => {
    let resolvePeek: (value: string | null) => void = () => {};
    const peek = mock(
      () =>
        new Promise<string | null>((resolve) => {
          resolvePeek = resolve;
        }),
    );
    const persistenceFactory = mock(makePersistenceStub);
    pool = new ProviderPool(3, DUMMY_WS, {
      storage: null,
      persistenceFactory,
      peekStoredLineageEpoch: peek,
    });
    pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
    const docName = uniqueDocName('pp-spine-own');
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    expect(peek).toHaveBeenCalledTimes(1);

    // The id transitioning again re-runs the deferred pass over the entry
    // (persistence still null) — the in-flight run owns the attach.
    pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
    expect(peek).toHaveBeenCalledTimes(1);

    resolvePeek(null);
    await awaitAttachedPersistence(entry);
    expect(persistenceFactory).toHaveBeenCalledTimes(1);
  });

  test('a rejecting peek leaves the entry cacheless and emits the attach-failed arm', async () => {
    const warns = captureWarns();
    try {
      const persistenceFactory = mock(makePersistenceStub);
      const peek = mock(async (): Promise<string | null> => {
        throw new Error('idb exploded');
      });
      pool = new ProviderPool(3, DUMMY_WS, {
        storage: null,
        persistenceFactory,
        peekStoredLineageEpoch: peek,
      });
      pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
      const docName = uniqueDocName('pp-spine-peek-reject');
      const entry = pool.open(docName);
      if (!entry) throw new Error('expected entry');

      const emitted = await waitFor(
        () => warns.lines().some((line) => line.includes('ok-client-persistence-attach-failed')),
        2_000,
      );
      expect(emitted).toBe(true);
      const lines = warns
        .lines()
        .filter((line) => line.includes('ok-client-persistence-attach-failed'));
      expect(lines.length).toBe(1);
      const event = JSON.parse(lines[0] ?? '{}') as Record<string, string>;
      expect(event.docName).toBe(docName);
      expect(event.phase).toBe('peek');
      expect(event.errorMessage).toBe('idb exploded');
      // Stored state we cannot read must not hydrate — the load-bearing
      // fail-safe of the seam: no attach, entry stays cacheless.
      expect(entry.persistence).toBeNull();
      expect(persistenceFactory).not.toHaveBeenCalled();
    } finally {
      warns.restore();
    }
  });

  test('a wedged peek decays into the attach-failed arm after the timeout', async () => {
    const warns = captureWarns();
    try {
      const persistenceFactory = mock(makePersistenceStub);
      // Never settles — the cross-tab-blocked-delete wedge shape.
      const peek = mock(() => new Promise<string | null>(() => {}));
      pool = new ProviderPool(3, DUMMY_WS, {
        storage: null,
        persistenceFactory,
        peekStoredLineageEpoch: peek,
        clearDataTimeoutMs: 20,
      });
      pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
      const docName = uniqueDocName('pp-spine-peek-wedge');
      const entry = pool.open(docName);
      if (!entry) throw new Error('expected entry');

      const emitted = await waitFor(
        () => warns.lines().some((line) => line.includes('ok-client-persistence-attach-failed')),
        2_000,
      );
      expect(emitted).toBe(true);
      const lines = warns
        .lines()
        .filter((line) => line.includes('ok-client-persistence-attach-failed'));
      const event = JSON.parse(lines[0] ?? '{}') as Record<string, string>;
      expect(event.docName).toBe(docName);
      expect(event.phase).toBe('peek');
      expect(event.errorName).toBe('StoredEpochPeekTimeoutError');
      expect(entry.persistence).toBeNull();
      expect(persistenceFactory).not.toHaveBeenCalled();
    } finally {
      warns.restore();
    }
  });

  test('a throwing factory on the matched-epoch arm emits attach-failed and leaves the entry cacheless', async () => {
    const warns = captureWarns();
    try {
      const peek = mock(async () => 'epoch-live');
      const persistenceFactory = mock((): ClientPersistenceProvider => {
        throw new Error('factory exploded');
      });
      pool = new ProviderPool(3, DUMMY_WS, {
        storage: null,
        persistenceFactory,
        peekStoredLineageEpoch: peek,
      });
      pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
      const docName = uniqueDocName('pp-spine-factory-throw');
      const entry = pool.open(docName);
      if (!entry) throw new Error('expected entry');
      entry.provider.document.getMap('lifecycle').set('epoch', 'epoch-live');
      entry.provider.emit('synced', { state: true });

      const emitted = await waitFor(
        () => warns.lines().some((line) => line.includes('ok-client-persistence-attach-failed')),
        2_000,
      );
      expect(emitted).toBe(true);
      const lines = warns
        .lines()
        .filter((line) => line.includes('ok-client-persistence-attach-failed'));
      const event = JSON.parse(lines[0] ?? '{}') as Record<string, string>;
      expect(event.docName).toBe(docName);
      expect(event.phase).toBe('attach');
      expect(event.errorMessage).toBe('factory exploded');
      expect(entry.persistence).toBeNull();
    } finally {
      warns.restore();
    }
  });

  test('a failing backfill emits the structured attach-failed event with phase backfill', async () => {
    const warns = captureWarns();
    try {
      const persistenceFactory = mock(
        () =>
          ({
            whenSynced: Promise.resolve(undefined as never),
            synced: true,
            destroy: async () => {},
            clearData: async () => {},
            flushFullState: async () => {
              throw new Error('backfill exploded');
            },
          }) as unknown as ClientPersistenceProvider,
      );
      const peek = mock(async () => null);
      pool = new ProviderPool(3, DUMMY_WS, {
        storage: null,
        persistenceFactory,
        peekStoredLineageEpoch: peek,
      });
      pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
      const docName = uniqueDocName('pp-spine-backfill-fail');
      const entry = pool.open(docName);
      if (!entry) throw new Error('expected entry');
      await awaitAttachedPersistence(entry);
      // The backfill flushes only once the entry's first WS sync lands.
      entry.provider.emit('synced', { state: true });

      const emitted = await waitFor(
        () => warns.lines().some((line) => line.includes('ok-client-persistence-attach-failed')),
        2_000,
      );
      expect(emitted).toBe(true);
      const lines = warns
        .lines()
        .filter((line) => line.includes('ok-client-persistence-attach-failed'));
      const event = JSON.parse(lines[0] ?? '{}') as Record<string, string>;
      expect(event.docName).toBe(docName);
      expect(event.phase).toBe('backfill');
      expect(event.errorMessage).toBe('backfill exploded');
      // A failed backfill degrades the cache's completeness, not the
      // attach itself — persistence stays wired.
      expect(entry.persistence).not.toBeNull();
    } finally {
      warns.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// MECHANISM-ONLY tests for `authenticationFailed` → recycle-all wiring.
// These assert the pool's response to the specific
// rejection reason; they do NOT verify that a real server restart produces a
// duplication-free Y.Doc. That end-to-end behavior is covered by
// the integration test suite.
// ---------------------------------------------------------------------------
describe("ProviderPool authenticationFailed handling (US-002 / 'server-instance-mismatch')", () => {
  // the recycle path is now async — it awaits
  // `persistence.clearData()` on every entry BEFORE destroying providers
  // so the fresh providers hydrate empty IDB (the load-bearing ordering
  // that prevents the content-duplication bug class). Tests below wait a
  // short real-time tick so fake-indexeddb's `deleteDatabase` can complete
  // before the recycled state is asserted.

  test("reason 'server-instance-mismatch' recycles every pool entry", async () => {
    pool = new ProviderPool(3, DUMMY_WS, { storage: null });
    pool.setExpectedServerInstanceId('server-old');

    const e1 = pool.open('doc1');
    const e2 = pool.open('doc2');
    const e3 = pool.open('doc3');
    if (!e1 || !e2 || !e3) throw new Error('expected entries');
    pool.setActive('doc1');
    const originalProvider = e1.provider;

    // Simulate the server's reject on the active doc's provider.
    e1.provider.emit('authenticationFailed', { reason: 'server-instance-mismatch' });
    await pool.awaitMismatchSettled();

    // Active doc re-opens with a fresh provider (preserving activeDocName);
    // non-active docs are destroyed — the user navigating to them later
    // will get a fresh provider on next open(), which is exactly what we
    // want (no stale Y.Doc from the prior server incarnation ever merges
    // with fresh server state).
    expect(pool.has('doc1')).toBe(true);
    expect(pool.has('doc2')).toBe(false);
    expect(pool.has('doc3')).toBe(false);
    const postE1 = pool.entries.get('doc1');
    expect(postE1?.provider).not.toBe(originalProvider);
    expect(pool.getActiveDocName()).toBe('doc1');
  });

  test("reason 'server-instance-mismatch' clears the stale current instance claim", async () => {
    pool = new ProviderPool(3, DUMMY_WS, { storage: null });
    pool.setExpectedServerInstanceId('server-old');
    const entry = pool.open('doc1');
    if (!entry) throw new Error('expected entry');
    pool.setActive('doc1');

    entry.provider.emit('authenticationFailed', { reason: 'server-instance-mismatch' });

    // The re-opened provider's token must NOT carry the old claim — that's
    // the whole point of the recycle. HocuspocusProvider defaults token to
    // `null` when not passed, so we accept null OR undefined; the only
    // failure mode is a string containing the stale serverInstanceId.
    const claimCleared = await waitFor(() => {
      const replaced = pool.entries.get('doc1');
      if (!replaced || replaced === entry) return false;
      const resolved = replaced.provider.configuration.token;
      if (typeof resolved !== 'string') return true;
      const parsed = parseHocuspocusAuthToken(resolved);
      return parsed?.expectedServerInstanceId === undefined;
    });
    expect(claimCleared).toBe(true);
    const replaced = pool.entries.get('doc1');
    if (!replaced) throw new Error('expected replaced entry');
    const resolved = replaced.provider.configuration.token;
    if (typeof resolved === 'string') {
      const parsed = parseHocuspocusAuthToken(resolved);
      expect(parsed?.expectedServerInstanceId).toBeUndefined();
    }
    // Re-seeding via the post-mismatch boot would only happen via a fresh
    // GET /api/server-info in prod — this is mechanism, not that flow.
  });

  test('other reasons do not trigger recycle', () => {
    pool = new ProviderPool(3, DUMMY_WS, { storage: null });
    pool.setExpectedServerInstanceId('server-old');
    const entry = pool.open('doc1');
    if (!entry) throw new Error('expected entry');
    pool.setActive('doc1');
    const originalProvider = entry.provider;

    entry.provider.emit('authenticationFailed', { reason: 'permission-denied' });

    expect(pool.getActive()?.provider).toBe(originalProvider);
    // Cache is preserved for other reasons.
    const resolved = originalProvider.configuration.token as unknown;
    expect(resolved).toBeDefined();
  });

  test('second mismatch event is a no-op after cache is cleared (idempotence)', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      pool = new ProviderPool(3, DUMMY_WS, { storage: null });
      pool.setExpectedServerInstanceId('server-old');
      pool.setObservedBranch('telemetry-branch-idem');
      const entry = pool.open('doc1');
      if (!entry) throw new Error('expected entry');
      pool.setActive('doc1');

      entry.provider.emit('authenticationFailed', { reason: 'server-instance-mismatch' });
      const firstRecycled = await waitFor(() => {
        const postFirstEntry = pool.entries.get('doc1');
        return postFirstEntry !== undefined && postFirstEntry.provider !== entry.provider;
      });
      expect(firstRecycled).toBe(true);
      const postFirstEntry = pool.entries.get('doc1');
      if (!postFirstEntry) throw new Error('expected post-first entry');
      const postFirstProvider = postFirstEntry.provider;

      const epochSignals = warnSpy.mock.calls.filter(([first]) => {
        if (typeof first !== 'string') return false;
        try {
          return JSON.parse(first).event === 'ok-client-cache-epoch-mismatch';
        } catch {
          return false;
        }
      });
      expect(epochSignals.length).toBe(1);

      postFirstProvider.emit('authenticationFailed', { reason: 'server-instance-mismatch' });
      await wait(0);
      const epochAfterSecond = warnSpy.mock.calls.filter(([first]) => {
        if (typeof first !== 'string') return false;
        try {
          return JSON.parse(first).event === 'ok-client-cache-epoch-mismatch';
        } catch {
          return false;
        }
      });
      expect(epochAfterSecond.length).toBe(1);

      const postSecond = pool.entries.get('doc1');
      expect(postSecond?.provider).toBe(postFirstProvider);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('server-instance-mismatch exposes recovery state and clears it after fresh sync', async () => {
    __resetSyncPromiseCache();
    pool = new ProviderPool(3, DUMMY_WS, { storage: null });
    pool.setExpectedServerInstanceId('server-old');
    const entry = pool.open('doc1');
    if (!entry) throw new Error('expected entry');
    const persistence = await awaitAttachedPersistence(entry);
    pool.setActive('doc1');

    let resolveClear: () => void = () => {};
    persistence.clearData = mock(
      () =>
        new Promise<void>((resolve) => {
          resolveClear = resolve;
        }),
    );

    syncPromise('doc1', entry.provider).catch(() => {});
    expect(__syncPromiseCacheSize()).toBe(1);

    entry.provider.emit('authenticationFailed', { reason: 'server-instance-mismatch' });

    expect(__syncPromiseCacheSize()).toBe(0);
    expect(pool.getServerRestartRecoveryState()).toMatchObject({
      kind: 'recovering',
      phase: 'clearing-local-cache',
      docNames: ['doc1'],
    });

    resolveClear();
    await wait(50);

    expect(pool.getServerRestartRecoveryState()).toMatchObject({
      kind: 'recovering',
      phase: 'reconnecting',
      docNames: ['doc1'],
    });

    const replacement = pool.getActive();
    if (!replacement) throw new Error('expected replacement');
    replacement.observerCleanup = () => {};
    replacement.provider.emit('synced', { state: true });

    expect(pool.getServerRestartRecoveryState()).toEqual({ kind: 'idle' });
    __resetSyncPromiseCache();
  });

  test('active doc clearData failure exposes targeted recovery failure state', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      pool = new ProviderPool(3, DUMMY_WS);
      pool.setExpectedServerInstanceId('server-old');
      pool.setObservedBranch('clear-fail-branch');
      const entry = pool.open('doc1');
      if (!entry) throw new Error('expected entry');
      const persistence = await awaitAttachedPersistence(entry);
      pool.setActive('doc1');
      const originalProvider = entry.provider;
      persistence.clearData = mock(() => Promise.reject(new Error('idb blocked')));

      entry.provider.emit('authenticationFailed', { reason: 'server-instance-mismatch' });
      await wait(50);

      expect(pool.getActive()?.provider).toBe(originalProvider);
      expect(pool.getServerRestartRecoveryState()).toMatchObject({
        kind: 'failed',
        reason: 'clear-data-failed',
        docNames: ['doc1'],
        failedDocNames: ['doc1'],
      });

      const clearFailed = warnSpy.mock.calls
        .map((c) => c[0])
        .filter((first): first is string => typeof first === 'string')
        .filter((first) => {
          try {
            return JSON.parse(first).event === 'ok-client-cache-clear-failed';
          } catch {
            return false;
          }
        });
      expect(clearFailed.length).toBe(1);
      const payload = JSON.parse(clearFailed[0] ?? '{}') as {
        event: string;
        docName: string;
        branch: string;
        serverInstanceId?: string;
        failureKind: string;
        errorName?: string;
        errorMessage?: string;
      };
      expect(payload.docName).toBe('doc1');
      expect(payload.branch).toBe('clear-fail-branch');
      expect(payload.serverInstanceId).toBe('server-old');
      expect(payload.failureKind).toBe('rejected');
      expect(payload.errorName).toBe('Error');
      expect(payload.errorMessage).toBe('idb blocked');
      expect(Object.keys(payload).every((k) => !['message', 'stack', 'reason'].includes(k))).toBe(
        true,
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('active doc clearData timeout exposes targeted timeout state', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      pool = new ProviderPool(3, DUMMY_WS, { clearDataTimeoutMs: 5 });
      pool.setExpectedServerInstanceId('server-old');
      pool.setObservedBranch('timeout-branch');
      const entry = pool.open('doc1');
      if (!entry) throw new Error('expected entry');
      const persistence = await awaitAttachedPersistence(entry);
      pool.setActive('doc1');
      persistence.clearData = mock(() => new Promise<void>(() => {}));

      entry.provider.emit('authenticationFailed', { reason: 'server-instance-mismatch' });
      await wait(30);

      expect(pool.getServerRestartRecoveryState()).toMatchObject({
        kind: 'failed',
        reason: 'clear-data-timeout',
        docNames: ['doc1'],
        failedDocNames: ['doc1'],
      });

      const clearFailed = warnSpy.mock.calls
        .map((c) => c[0])
        .filter((first): first is string => typeof first === 'string')
        .filter((first) => {
          try {
            return JSON.parse(first).event === 'ok-client-cache-clear-failed';
          } catch {
            return false;
          }
        });
      expect(clearFailed.length).toBe(1);
      const payload = JSON.parse(clearFailed[0] ?? '{}') as { failureKind: string };
      expect(payload.failureKind).toBe('timeout');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('ProviderPool syncPromise lifecycle integration (F15)', () => {
  beforeEach(() => {
    __resetSyncPromiseCache();
  });

  afterEach(() => {
    __resetSyncPromiseCache();
  });

  test('close(docName) invalidates the cached syncPromise', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open('doc1');
    if (!entry) throw new Error('expected entry');
    // Create the cached promise (kept alive across later settlement by the .catch handler)
    const p = syncPromise('doc1', entry.provider);
    p.catch(() => {}); // swallow any pool-teardown rejection
    expect(__syncPromiseCacheSize()).toBe(1);

    pool.close('doc1');

    // Invalidation runs inside destroyEntry before provider.destroy() fires close
    expect(__syncPromiseCacheSize()).toBe(0);
  });

  test('LRU eviction invalidates the cached syncPromise of the evicted doc', () => {
    pool = new ProviderPool(2, DUMMY_WS);
    const e1 = pool.open('doc1');
    if (!e1) throw new Error('expected e1');
    pool.setActive('doc1');
    const e2 = pool.open('doc2');
    if (!e2) throw new Error('expected e2');

    syncPromise('doc1', e1.provider).catch(() => {});
    syncPromise('doc2', e2.provider).catch(() => {});
    expect(__syncPromiseCacheSize()).toBe(2);

    // Opening doc3 evicts doc2 (doc1 is active and protected)
    const e3 = pool.open('doc3');
    if (!e3) throw new Error('expected e3');

    expect(pool.has('doc2')).toBe(false);
    // doc1 + doc3's cache entry (doc3 hasn't had syncPromise called yet so just doc1)
    expect(__syncPromiseCacheSize()).toBe(1);
  });

  test('recycle after disconnect invalidates the cached syncPromise', async () => {
    pool = new ProviderPool(3, DUMMY_WS, { recycleDebounceMs: 50 });
    const entry = pool.open('doc1');
    if (!entry) throw new Error('expected entry');
    pool.setActive('doc1');
    // Pre-set observerCleanup so the recycle path's re-open doesn't try to
    // setupObservers against a dummy provider.
    entry.observerCleanup = () => {};

    // Simulate initial sync so the disconnect→recycle guard path is taken
    entry.hasSynced = true;
    entry.syncState = 'synced';
    entry.provider.unsyncedChanges = 0;

    syncPromise('doc1', entry.provider).catch(() => {});
    expect(__syncPromiseCacheSize()).toBe(1);

    // Disconnect → schedules recycle debounce timer
    entry.provider.emit('disconnect', {
      event: { code: 1006, reason: 'server restart', wasClean: false },
    });

    // Wait for debounce to fire
    await wait(100);

    // After recycle: original cache entry invalidated; re-opened provider has
    // no fresh syncPromise call yet, so cache is empty
    expect(__syncPromiseCacheSize()).toBe(0);
  });

  test('dispose() invalidates all cached syncPromises', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const e1 = pool.open('doc1');
    const e2 = pool.open('doc2');
    if (!e1 || !e2) throw new Error('expected entries');
    syncPromise('doc1', e1.provider).catch(() => {});
    syncPromise('doc2', e2.provider).catch(() => {});
    expect(__syncPromiseCacheSize()).toBe(2);

    pool.dispose();

    expect(__syncPromiseCacheSize()).toBe(0);
  });

  test('natural (network-triggered) close event rejects the syncPromise with PreSyncDisconnectError', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open('doc1');
    if (!entry) throw new Error('expected entry');
    const p = syncPromise('doc1', entry.provider);

    // Simulate a natural close event (network drop, server disconnect).
    // This is different from pool.close(docName) which goes through
    // invalidateSyncPromise first — here the listener fires naturally.
    entry.provider.emit('close', {
      event: { code: 1006, reason: 'network drop', wasClean: false },
    });

    await expect(p).rejects.toBeInstanceOf(PreSyncDisconnectError);
    // Cache entry stays as a settled sentinel after rejection — see
    // sync-promise.ts lifecycle docstring (subsequent React renders need to
    // see the same .status='rejected' thenable so the boundary catches).
    expect(__syncPromiseCacheSize()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Pool destroy must evict the editor cache before tearing down the provider.
// Otherwise the next cache-hit mount returns an Editor bound to an orphaned
// Y.Doc (split-brain typing, no sync, no persistence, no error boundary fires).
//
// Bun unit env has no DOM — we shape fake nodes that match the narrow
// HTMLElement surface the cache touches, mirroring editor-cache.test.ts.
// ---------------------------------------------------------------------------
interface FakeContainer {
  parentElement: FakeContainer | null;
  scrollTop: number;
  children: FakeContainer[];
  appendChild(child: FakeContainer): FakeContainer;
  removeChild(child: FakeContainer): FakeContainer;
  setAttribute(key: string, value: string): void;
  style: Record<string, string>;
}

function makeFakeNode(): FakeContainer {
  const node: FakeContainer = {
    parentElement: null,
    scrollTop: 0,
    children: [],
    style: {},
    setAttribute() {
      // no-op
    },
    appendChild(child) {
      if (child.parentElement) child.parentElement.removeChild(child);
      node.children.push(child);
      child.parentElement = node;
      return child;
    },
    removeChild(child) {
      const idx = node.children.indexOf(child);
      if (idx !== -1) node.children.splice(idx, 1);
      child.parentElement = null;
      return child;
    },
  };
  return node;
}

// ---------------------------------------------------------------------------
// DEV-only observer-fire counter.
// Counts Y.Doc `afterAllTransactions` drains that contain remote transactions,
// exposed on `globalThis.__okPerfCounters.providerObserverFires[docName]` so
// the scenario can measure per-docName fire rate across an N-peer sweep.
// ---------------------------------------------------------------------------

interface OkPerfCountersShape {
  providerObserverFires: Record<string, number>;
}

function readFireCount(docName: string): number {
  const counters = (globalThis as { __okPerfCounters?: OkPerfCountersShape }).__okPerfCounters;
  return counters?.providerObserverFires[docName] ?? 0;
}

function hasFireCountEntry(docName: string): boolean {
  const counters = (globalThis as { __okPerfCounters?: OkPerfCountersShape }).__okPerfCounters;
  return counters !== undefined && docName in counters.providerObserverFires;
}

function resetFireCounts(): void {
  const counters = (globalThis as { __okPerfCounters?: OkPerfCountersShape }).__okPerfCounters;
  if (counters) counters.providerObserverFires = {};
}

describe('US-003 (cap-calibration-probes): observer-fire counter for M5', () => {
  beforeEach(() => {
    resetFireCounts();
  });
  afterEach(() => {
    pool?.dispose();
    resetFireCounts();
  });

  test('increments on REMOTE transactions (Y.applyUpdate from a peer doc)', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open('doc-remote');
    if (!entry) throw new Error('expected entry');

    // Simulate a remote peer write by applying an external update to the
    // provider's Y.Doc. Y.applyUpdate triggers a transaction with local=false.
    const peerDoc = new Y.Doc();
    peerDoc.getText('source').insert(0, 'hello-from-peer');
    const update = Y.encodeStateAsUpdate(peerDoc);
    Y.applyUpdate(entry.provider.document, update);

    expect(readFireCount('doc-remote')).toBeGreaterThanOrEqual(1);
  });

  test('does NOT increment on LOCAL transactions (transact)', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open('doc-local');
    if (!entry) throw new Error('expected entry');

    // transact() produces a local transaction (transaction.local === true).
    entry.provider.document.transact(() => {
      entry.provider.document.getText('source').insert(0, 'local-write');
    });

    expect(readFireCount('doc-local')).toBe(0);
  });

  test('counter is per-docName (multiple docs tracked independently)', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const a = pool.open('doc-a');
    const b = pool.open('doc-b');
    if (!a || !b) throw new Error('expected entries');

    const peerA = new Y.Doc();
    peerA.getText('source').insert(0, 'a');
    Y.applyUpdate(a.provider.document, Y.encodeStateAsUpdate(peerA));

    const peerB = new Y.Doc();
    peerB.getText('source').insert(0, 'b');
    Y.applyUpdate(b.provider.document, Y.encodeStateAsUpdate(peerB));
    peerB.getText('source').insert(1, '2');
    Y.applyUpdate(b.provider.document, Y.encodeStateAsUpdate(peerB));

    expect(readFireCount('doc-a')).toBe(1);
    // doc-b got two remote applies — both count.
    expect(readFireCount('doc-b')).toBeGreaterThanOrEqual(2);
  });

  test('counter is removed on close (pool teardown path for evict)', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open('doc-evict');
    if (!entry) throw new Error('expected entry');
    const peer = new Y.Doc();
    peer.getText('source').insert(0, 'x');
    Y.applyUpdate(entry.provider.document, Y.encodeStateAsUpdate(peer));
    expect(hasFireCountEntry('doc-evict')).toBe(true);

    pool.close('doc-evict');

    expect(hasFireCountEntry('doc-evict')).toBe(false);
  });

  test('counter is removed on recycle (Try-Again retry path)', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open('doc-recycle');
    if (!entry) throw new Error('expected entry');
    pool.setActive('doc-recycle');
    const peer = new Y.Doc();
    peer.getText('source').insert(0, 'y');
    Y.applyUpdate(entry.provider.document, Y.encodeStateAsUpdate(peer));
    expect(hasFireCountEntry('doc-recycle')).toBe(true);

    pool.recycle('doc-recycle');

    // Recycle destroys entry and reopens fresh. The stale counter was deleted;
    // the fresh entry starts from 0 with no counter yet (written lazily on
    // first remote fire).
    expect(readFireCount('doc-recycle')).toBe(0);
  });

  test('counter is removed on dispose (pool teardown path for all entries)', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const a = pool.open('doc-disp-a');
    const b = pool.open('doc-disp-b');
    if (!a || !b) throw new Error('expected entries');
    const peer = new Y.Doc();
    peer.getText('source').insert(0, 'z');
    Y.applyUpdate(a.provider.document, Y.encodeStateAsUpdate(peer));
    Y.applyUpdate(b.provider.document, Y.encodeStateAsUpdate(peer));
    expect(hasFireCountEntry('doc-disp-a')).toBe(true);
    expect(hasFireCountEntry('doc-disp-b')).toBe(true);

    pool.dispose();

    expect(hasFireCountEntry('doc-disp-a')).toBe(false);
    expect(hasFireCountEntry('doc-disp-b')).toBe(false);
  });

  test('existing setupObservers / bridge is NOT modified (regression guard)', () => {
    // The counter is a PARALLEL observer attached alongside the existing
    // bridge observers — it must not enter through setupObservers or mutate
    // sync-promise state. A simple probe: remote-apply a transaction and
    // verify the provider entry does not flag bridgeSetupFailed (which is the
    // signal that setupObservers threw). No bridge-setup code has been called
    // here because we never fire 'synced'.
    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open('doc-nomod');
    if (!entry) throw new Error('expected entry');
    expect(entry.bridgeSetupFailed).toBe(false);

    const peer = new Y.Doc();
    peer.getText('source').insert(0, 'remote');
    Y.applyUpdate(entry.provider.document, Y.encodeStateAsUpdate(peer));

    expect(entry.bridgeSetupFailed).toBe(false);
    expect(readFireCount('doc-nomod')).toBeGreaterThanOrEqual(1);
  });

  test('globalThis.__okPerfCounters surface is reachable and well-shaped', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.open('doc-shape');
    const peer = new Y.Doc();
    peer.getText('source').insert(0, 'probe');
    const entry = pool.entries.get('doc-shape');
    if (!entry) throw new Error('expected entry');
    Y.applyUpdate(entry.provider.document, Y.encodeStateAsUpdate(peer));

    const counters = (globalThis as { __okPerfCounters?: OkPerfCountersShape }).__okPerfCounters;
    expect(counters).toBeDefined();
    expect(typeof counters?.providerObserverFires).toBe('object');
    expect(counters?.providerObserverFires['doc-shape']).toBeGreaterThanOrEqual(1);
  });
});

describe('ProviderPool → V2 editor cache eviction coupling (Critical #2)', () => {
  test('close() evicts both TipTap + CM cache entries before destroying the provider', async () => {
    const cacheModule = await import('./editor-cache');
    cacheModule.__resetCacheForTests();
    const fakeTipDom = makeFakeNode();
    const fakeCmDom = makeFakeNode();
    const fakeEditor = {
      editorView: { dom: fakeTipDom, scrollDOM: fakeTipDom },
      commands: { focus: mock(() => {}) },
      destroy: mock(() => {}),
    } as unknown as import('@tiptap/core').Editor;
    const fakeView = {
      dom: fakeCmDom,
      scrollDOM: fakeCmDom,
      focus: mock(() => {}),
      destroy: mock(() => {}),
    } as unknown as import('@codemirror/view').EditorView;
    const makeProv = () =>
      ({
        destroy: mock(() => {}),
        document: { destroy: mock(() => {}) } as unknown as import('yjs').Doc,
        awareness: null,
      }) as unknown as import('@hocuspocus/provider').HocuspocusProvider;
    const fakeYDoc = { destroy: mock(() => {}) } as unknown as import('yjs').Doc;
    const fakeYText = { toString: () => '' } as unknown as import('yjs').Text;

    cacheModule.mountTiptapEditor({
      docName: 'doc-eviction-regression',
      container: makeFakeNode() as unknown as HTMLElement,
      factory: () => ({
        editor: fakeEditor,
        ydoc: fakeYDoc,
        ytext: fakeYText,
        provider: makeProv(),
      }),
    });
    cacheModule.mountCmEditor({
      docName: 'doc-eviction-regression',
      container: makeFakeNode() as unknown as HTMLElement,
      factory: () => ({
        view: fakeView,
        ydoc: fakeYDoc,
        ytext: fakeYText,
        provider: makeProv(),
        themeCompartment: new Compartment(),
        wordWrapCompartment: new Compartment(),
        placeholderCompartment: new Compartment(),
      }),
    });
    expect(cacheModule.peekTiptap('doc-eviction-regression')).toBeDefined();
    expect(cacheModule.__peekCm('doc-eviction-regression')).toBeDefined();

    // Now open + close through the pool. The cache subscribes to the
    // pool's eviction event (DocumentContext wires this in production
    // via subscribePoolEviction; tests must wire it explicitly to
    // exercise the same end-to-end behavior).
    pool = new ProviderPool(3, DUMMY_WS);
    cacheModule.subscribePoolEviction(pool);
    pool.open('doc-eviction-regression');
    pool.close('doc-eviction-regression');

    expect(cacheModule.peekTiptap('doc-eviction-regression')).toBeUndefined();
    expect(cacheModule.__peekCm('doc-eviction-regression')).toBeUndefined();
  });

  test('recycle() also evicts both caches (used by Try-Again retry path)', async () => {
    const cacheModule = await import('./editor-cache');
    cacheModule.__resetCacheForTests();
    const fakeTipDom = makeFakeNode();
    const fakeCmDom = makeFakeNode();
    const fakeEditor = {
      editorView: { dom: fakeTipDom, scrollDOM: fakeTipDom },
      commands: { focus: mock(() => {}) },
      destroy: mock(() => {}),
    } as unknown as import('@tiptap/core').Editor;
    const fakeView = {
      dom: fakeCmDom,
      scrollDOM: fakeCmDom,
      focus: mock(() => {}),
      destroy: mock(() => {}),
    } as unknown as import('@codemirror/view').EditorView;
    const makeProv = () =>
      ({
        destroy: mock(() => {}),
        document: { destroy: mock(() => {}) } as unknown as import('yjs').Doc,
        awareness: null,
      }) as unknown as import('@hocuspocus/provider').HocuspocusProvider;
    const fakeYDoc = { destroy: mock(() => {}) } as unknown as import('yjs').Doc;
    const fakeYText = { toString: () => '' } as unknown as import('yjs').Text;
    cacheModule.mountTiptapEditor({
      docName: 'doc-recycle-regression',
      container: makeFakeNode() as unknown as HTMLElement,
      factory: () => ({
        editor: fakeEditor,
        ydoc: fakeYDoc,
        ytext: fakeYText,
        provider: makeProv(),
      }),
    });
    cacheModule.mountCmEditor({
      docName: 'doc-recycle-regression',
      container: makeFakeNode() as unknown as HTMLElement,
      factory: () => ({
        view: fakeView,
        ydoc: fakeYDoc,
        ytext: fakeYText,
        provider: makeProv(),
        themeCompartment: new Compartment(),
        wordWrapCompartment: new Compartment(),
        placeholderCompartment: new Compartment(),
      }),
    });

    pool = new ProviderPool(3, DUMMY_WS);
    cacheModule.subscribePoolEviction(pool);
    pool.open('doc-recycle-regression');
    pool.recycle('doc-recycle-regression');

    expect(cacheModule.peekTiptap('doc-recycle-regression')).toBeUndefined();
    expect(cacheModule.__peekCm('doc-recycle-regression')).toBeUndefined();
  });

  test('dispose() evicts all cached editors across all pool entries', async () => {
    const cacheModule = await import('./editor-cache');
    cacheModule.__resetCacheForTests();
    const makeProv = () =>
      ({
        destroy: mock(() => {}),
        document: { destroy: mock(() => {}) } as unknown as import('yjs').Doc,
        awareness: null,
      }) as unknown as import('@hocuspocus/provider').HocuspocusProvider;
    const makeFakeEditor = () => {
      const dom = makeFakeNode();
      return {
        editorView: { dom, scrollDOM: dom },
        commands: { focus: mock(() => {}) },
        destroy: mock(() => {}),
      } as unknown as import('@tiptap/core').Editor;
    };
    const fakeYText = { toString: () => '' } as unknown as import('yjs').Text;

    cacheModule.mountTiptapEditor({
      docName: 'dispose-a',
      container: makeFakeNode() as unknown as HTMLElement,
      factory: () => ({
        editor: makeFakeEditor(),
        ydoc: { destroy: mock(() => {}) } as unknown as import('yjs').Doc,
        ytext: fakeYText,
        provider: makeProv(),
      }),
    });
    cacheModule.mountTiptapEditor({
      docName: 'dispose-b',
      container: makeFakeNode() as unknown as HTMLElement,
      factory: () => ({
        editor: makeFakeEditor(),
        ydoc: { destroy: mock(() => {}) } as unknown as import('yjs').Doc,
        ytext: fakeYText,
        provider: makeProv(),
      }),
    });

    pool = new ProviderPool(3, DUMMY_WS);
    cacheModule.subscribePoolEviction(pool);
    pool.open('dispose-a');
    pool.open('dispose-b');
    pool.dispose();

    expect(cacheModule.peekTiptap('dispose-a')).toBeUndefined();
    expect(cacheModule.peekTiptap('dispose-b')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// MECHANISM-ONLY tests for client-side y-indexeddb persistence wiring.
// These assert that every open() entry gets a
// ClientPersistenceProvider and that destruction order is persistence-before-
// provider across every teardown path (close, recycleDisconnectedEntry,
// evictLru, dispose). They do NOT assert buffer-and-replay — that wires in
// via the authenticationFailed handler, covered by an integration
// test against a real Hocuspocus server.
//
// Uses unique doc names per test (randomUUID) so fake-indexeddb state from a
// prior test doesn't leak across cases — different docNames map to different
// IDB databases (named `ok-ydoc:${branch}:${serverInstanceId}:${docName}`).
// ---------------------------------------------------------------------------
describe('ProviderPool client-persistence attachment (US-003)', () => {
  function stubPersistence(): ClientPersistenceProvider {
    return {
      whenSynced: Promise.resolve(undefined as never),
      synced: true,
      destroy: mock(async () => {}),
      clearData: mock(async () => {}),
      flushFullState: async () => {},
    } as ClientPersistenceProvider;
  }

  test('open() attaches a ClientPersistenceProvider to the pool entry', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
    const docName = uniqueDocName();
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    const persistence = await awaitAttachedPersistence(entry);
    expect(typeof persistence.destroy).toBe('function');
    expect(typeof persistence.clearData).toBe('function');
  });

  test('open() before serverInstanceId is known leaves persistence null', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const docName = uniqueDocName();
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    expect(entry.persistence).toBeNull();
  });

  test('deferred persistence attach continues after one entry throws', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const badDoc = uniqueDocName('pp-deferred-throw');
      const goodDoc = uniqueDocName('pp-deferred-ok');
      const goodPersistence = stubPersistence();
      const persistenceFactory = mock(({ docName }: { docName: string }) => {
        if (docName === badDoc) {
          throw new Error('idb unavailable');
        }
        return goodPersistence;
      });

      pool = new ProviderPool(3, DUMMY_WS, { persistenceFactory });
      const badEntry = pool.open(badDoc);
      const goodEntry = pool.open(goodDoc);
      if (!badEntry || !goodEntry) throw new Error('expected entries');
      expect(badEntry.persistence).toBeNull();
      expect(goodEntry.persistence).toBeNull();

      expect(() => pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID)).not.toThrow();

      await awaitAttachedPersistence(goodEntry);
      expect(goodEntry.persistence).toBe(goodPersistence);
      await waitFor(() => persistenceFactory.mock.calls.length === 2, 2_000);
      expect(persistenceFactory).toHaveBeenCalledTimes(2);
      expect(badEntry.persistence).toBeNull();
      const events = warnSpy.mock.calls.map((call) => String(call[0] ?? ''));
      expect(
        events.some((event) => event.includes('"event":"ok-client-persistence-attach-failed"')),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('re-opening the same docName reuses the existing persistence instance', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
    const docName = uniqueDocName();
    const entry1 = pool.open(docName);
    if (!entry1) throw new Error('expected entry1');
    const persistence1 = await awaitAttachedPersistence(entry1);
    const entry2 = pool.open(docName);
    expect(entry2?.persistence).toBe(persistence1);
  });

  test('prewarm() also attaches a persistence instance', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
    const docName = uniqueDocName('pp-prewarm');
    const entry = pool.prewarm(docName);
    if (!entry) throw new Error('expected prewarmed entry');
    await awaitAttachedPersistence(entry);
    expect(entry.persistence).not.toBeNull();
  });

  test('close() destroys the persistence before the provider', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
    const docName = uniqueDocName('pp-close');
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    const attached = await awaitAttachedPersistence(entry);

    const order: string[] = [];
    const persistenceSpy = mock(async () => {
      order.push('persistence');
    });
    attached.destroy = persistenceSpy;

    const origProviderDestroy = entry.provider.destroy.bind(entry.provider);
    entry.provider.destroy = (() => {
      order.push('provider');
      origProviderDestroy();
    }) as typeof entry.provider.destroy;

    pool.close(docName);

    expect(persistenceSpy).toHaveBeenCalledTimes(1);
    expect(order[0]).toBe('persistence');
    expect(order[1]).toBe('provider');
  });

  test('recycleDisconnectedEntry destroys the persistence before the provider', async () => {
    pool = new ProviderPool(3, DUMMY_WS, { recycleDebounceMs: 50 });
    pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
    const docName = uniqueDocName('pp-recycle');
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    const attached = await awaitAttachedPersistence(entry);
    pool.setActive(docName);
    // Skip setupObservers when the recycle path re-opens (we aren't testing it)
    entry.observerCleanup = () => {};

    const order: string[] = [];
    const persistenceSpy = mock(async () => {
      order.push('persistence');
    });
    attached.destroy = persistenceSpy;

    const origProviderDestroy = entry.provider.destroy.bind(entry.provider);
    entry.provider.destroy = (() => {
      order.push('provider');
      origProviderDestroy();
    }) as typeof entry.provider.destroy;

    entry.hasSynced = true;
    entry.syncState = 'synced';
    entry.provider.unsyncedChanges = 0;
    entry.provider.emit('disconnect', {
      event: { code: 1006, reason: 'server restart', wasClean: false },
    });
    await wait(100);

    expect(persistenceSpy).toHaveBeenCalledTimes(1);
    expect(order[0]).toBe('persistence');
    expect(order[1]).toBe('provider');
  });

  test('evictLru destroys the persistence on the evicted entry', async () => {
    pool = new ProviderPool(2, DUMMY_WS);
    pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
    const doc1 = uniqueDocName('pp-evict');
    const doc2 = uniqueDocName('pp-evict');
    const doc3 = uniqueDocName('pp-evict');
    pool.open(doc1);
    pool.setActive(doc1);
    const entry2 = pool.open(doc2);
    if (!entry2) throw new Error('expected entry on doc2');
    const attached2 = await awaitAttachedPersistence(entry2);

    const destroySpy = mock(async () => {});
    attached2.destroy = destroySpy;

    // Opening doc3 at capacity evicts doc2 (doc1 is active + protected)
    pool.open(doc3);

    expect(pool.has(doc2)).toBe(false);
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  test('dispose() destroys every pool entry’s persistence', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
    const doc1 = uniqueDocName('pp-dispose');
    const doc2 = uniqueDocName('pp-dispose');
    const e1 = pool.open(doc1);
    const e2 = pool.open(doc2);
    if (!e1 || !e2) throw new Error('expected entries');
    const p1 = await awaitAttachedPersistence(e1);
    const p2 = await awaitAttachedPersistence(e2);

    const spy1 = mock(async () => {});
    const spy2 = mock(async () => {});
    p1.destroy = spy1;
    p2.destroy = spy2;

    pool.dispose();

    expect(spy1).toHaveBeenCalledTimes(1);
    expect(spy2).toHaveBeenCalledTimes(1);
  });

  test('closeAndClearPersistence calls clearData on a pooled entry, then closes it', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
    const docName = uniqueDocName('pp-rename-clear');
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    const attached = await awaitAttachedPersistence(entry);

    const clearSpy = mock(async () => {});
    attached.clearData = clearSpy;

    await pool.closeAndClearPersistence(docName);

    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(pool.has(docName)).toBe(false);
  });

  test('closeAndClearPersistence deletes the IDB directly when the doc is not in the pool', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setObservedBranch('main');
    pool.setExpectedServerInstanceId('server-rename-orphan');
    const docName = uniqueDocName('pp-rename-orphan');
    const dbName = `ok-ydoc:main:server-rename-orphan:${docName}`;

    // Seed an IDB at the canonical name so we have something to delete.
    // Mirrors the "doc occupied this name in a previous session" state.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });

    let dbs = await indexedDB.databases();
    expect(dbs.find((d) => d.name === dbName)).toBeDefined();

    expect(pool.has(docName)).toBe(false);
    await pool.closeAndClearPersistence(docName);

    dbs = await indexedDB.databases();
    expect(dbs.find((d) => d.name === dbName)).toBeUndefined();
  });

  test('closeAndClearPersistence is a no-op when serverInstanceId is unknown and doc not in pool', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setObservedBranch('main');
    // No setExpectedServerInstanceId — cachedServerInstanceId stays null.
    const docName = uniqueDocName('pp-rename-noepoch');

    // Seed an IDB at a name that DOES match the canonical pattern for some
    // other epoch. Without an epoch known, the pool can't compute the
    // current name and skips the delete — that's correct, because no
    // current-epoch IDB could possibly exist (no provider attached yet).
    const dbName = `ok-ydoc:main:server-prior:${docName}`;
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });

    await pool.closeAndClearPersistence(docName);

    const dbs = await indexedDB.databases();
    // Other-epoch IDB is left alone (out of scope for this pool's current
    // epoch); no current-epoch IDB exists either.
    expect(dbs.find((d) => d.name === dbName)).toBeDefined();

    // Cleanup so afterEach doesn't see leftover state.
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(dbName);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  });

  test('rename round-trip (A→B→A) clears IDB so reopen at A starts fresh', async () => {
    // The user-reported duplication scenario, scoped to the pool's IDB
    // contract: a doc lives at name A, gets moved to B, then later moved
    // back to A. Without `closeAndClearPersistence`, the IDB at A retains
    // rows from the first session (foreign clientID); the second open at
    // A would hydrate the new Y.Doc from those rows, then union-merge
    // with the server's freshly-loaded body — appending duplicate
    // content because the two histories share no ancestor. With the
    // clear, the IDB at A is gone before the reopen, so the new provider
    // syncs the server's content cleanly.
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setObservedBranch('main');
    pool.setExpectedServerInstanceId('server-roundtrip');
    const nameA = uniqueDocName('pp-roundtrip-A');
    const nameB = uniqueDocName('pp-roundtrip-B');
    const dbA = `ok-ydoc:main:server-roundtrip:${nameA}`;
    const dbB = `ok-ydoc:main:server-roundtrip:${nameB}`;

    // Step 1: open A, let its persistence write to IDB, close it.
    const entryA1 = pool.open(nameA);
    if (!entryA1) throw new Error('expected entry');
    await (await awaitAttachedPersistence(entryA1)).whenSynced;
    let dbs = await indexedDB.databases();
    expect(dbs.find((d) => d.name === dbA)).toBeDefined();

    // Step 2: rename A → B. The fix calls closeAndClearPersistence on
    // both fromDocName (A) AND toDocName (B). A's IDB must go away;
    // B's IDB doesn't exist yet, so the second call is a no-op.
    await pool.closeAndClearPersistence(nameA);
    await pool.closeAndClearPersistence(nameB);
    dbs = await indexedDB.databases();
    expect(dbs.find((d) => d.name === dbA)).toBeUndefined();
    expect(dbs.find((d) => d.name === dbB)).toBeUndefined();

    // Step 3: open B (the new location), let it persist, close it.
    const entryB = pool.open(nameB);
    if (!entryB) throw new Error('expected entry');
    await (await awaitAttachedPersistence(entryB)).whenSynced;
    dbs = await indexedDB.databases();
    expect(dbs.find((d) => d.name === dbB)).toBeDefined();

    // Step 4: rename B → A (the move-back). This is the critical step:
    // both ends get cleared, so neither A's residual nor B's residual
    // can leak into a future open.
    await pool.closeAndClearPersistence(nameB);
    await pool.closeAndClearPersistence(nameA);
    dbs = await indexedDB.databases();
    expect(dbs.find((d) => d.name === dbA)).toBeUndefined();
    expect(dbs.find((d) => d.name === dbB)).toBeUndefined();

    // Step 5: open A again. With the IDB cleared in step 4, the new
    // persistence creates a fresh DB — no leftover rows from step 1 to
    // hydrate the Y.Doc with stale content. The IDB-deletion contract
    // verified across steps 2 and 4 is the precise lever the fix pulls;
    // CRDT-level non-merge requires a real Hocuspocus + content and is
    // covered by an integration test against the full collab stack.
    const entryA2 = pool.open(nameA);
    if (!entryA2) throw new Error('expected entry');
    await (await awaitAttachedPersistence(entryA2)).whenSynced;
    dbs = await indexedDB.databases();
    expect(dbs.find((d) => d.name === dbA)).toBeDefined();
  });

  test('server-instance-mismatch calls clearData on every entry before destroying', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setExpectedServerInstanceId('server-old');
    const doc1 = uniqueDocName('pp-mismatch');
    const doc2 = uniqueDocName('pp-mismatch');
    const e1 = pool.open(doc1);
    const e2 = pool.open(doc2);
    if (!e1 || !e2) throw new Error('expected entries');
    const p1 = await awaitAttachedPersistence(e1);
    const p2 = await awaitAttachedPersistence(e2);
    pool.setActive(doc1);
    e1.observerCleanup = () => {};

    const clearSpy1 = mock(async () => {});
    const clearSpy2 = mock(async () => {});
    p1.clearData = clearSpy1;
    p2.clearData = clearSpy2;

    // server-instance-mismatch: buffer → clearData every entry → recycle
    e1.provider.emit('authenticationFailed', { reason: 'server-instance-mismatch' });
    await wait(50);

    expect(clearSpy1).toHaveBeenCalledTimes(1);
    expect(clearSpy2).toHaveBeenCalledTimes(1);
    // Non-active doc2 is gone; active doc1 is re-opened with a fresh provider.
    expect(pool.has(doc2)).toBe(false);
    expect(pool.has(doc1)).toBe(true);
  });

  // Partial clearData failure: when only some entries' clears succeed, the
  // pool must still recycle the cleared entries (their IDB is empty + safe
  // to recycle into) while leaving failed entries inert. An all-or-none
  // gate would re-open the duplication class for the cleared docs because
  // the stale instance claim is cleared at the mismatch-handler entry —
  // the next reconnect no longer rejects before stale IDB can be wiped, and
  // Yjs additively merges pre-restart-clientID items into the post-restart
  // server state.
  test('server-instance-mismatch with partial clearData failure recycles cleared entries only', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setExpectedServerInstanceId('server-old');
    const doc1 = uniqueDocName('pp-partial-ok');
    const doc2 = uniqueDocName('pp-partial-fail');
    const doc3 = uniqueDocName('pp-partial-ok2');
    const e1 = pool.open(doc1);
    const e2 = pool.open(doc2);
    const e3 = pool.open(doc3);
    if (!e1 || !e2 || !e3) {
      throw new Error('expected entries');
    }
    const p1 = await awaitAttachedPersistence(e1);
    const p2 = await awaitAttachedPersistence(e2);
    const p3 = await awaitAttachedPersistence(e3);
    pool.setActive(doc1);
    // Pre-set observerCleanup so onSynced skips setupObservers paths
    e1.observerCleanup = () => {};
    e2.observerCleanup = () => {};
    e3.observerCleanup = () => {};

    // Capture pre-recycle provider refs so we can detect identity change
    // after the per-entry recycle.
    const preProvider1 = e1.provider;
    const preProvider2 = e2.provider;
    const preProvider3 = e3.provider;

    const clearOk1 = mock(async () => {});
    const clearFail = mock(() => Promise.reject(new Error('idb-clear-blocked')));
    const clearOk2 = mock(async () => {});
    p1.clearData = clearOk1;
    p2.clearData = clearFail;
    p3.clearData = clearOk2;

    e1.provider.emit('authenticationFailed', { reason: 'server-instance-mismatch' });
    await wait(50);

    // Every clearData was attempted.
    expect(clearOk1).toHaveBeenCalledTimes(1);
    expect(clearFail).toHaveBeenCalledTimes(1);
    expect(clearOk2).toHaveBeenCalledTimes(1);

    // doc1 is active — re-opened with a fresh provider after recycle.
    const post1 = pool.entries.get(doc1);
    if (!post1 || post1.kind !== 'active') throw new Error('expected active doc1 post-recycle');
    expect(post1.provider).not.toBe(preProvider1);

    // doc3 cleared successfully but is non-active — recycled (entry removed).
    expect(pool.has(doc3)).toBe(false);

    // doc2 cleared FAILED — entry NOT recycled. The pre-recycle provider
    // must still be the one in the pool (proves the failed-clear path
    // didn't tear it down or replace it).
    const post2 = pool.entries.get(doc2);
    if (!post2 || post2.kind !== 'active') throw new Error('expected active doc2 still in pool');
    expect(post2.provider).toBe(preProvider2);
    // Silence unused warning: preProvider3 is captured for symmetry but
    // doc3 was non-active and was destroyed, so there's no post-state ref
    // to compare against.
    void preProvider3;
  });

  test('partial clearData with timeout preserves timeout reason after active reconnect syncs', async () => {
    pool = new ProviderPool(3, DUMMY_WS, { clearDataTimeoutMs: 15 });
    pool.setExpectedServerInstanceId('server-old');
    const docActive = uniqueDocName('pp-partial-timeout-active');
    const docHung = uniqueDocName('pp-partial-timeout-hung');
    const ea = pool.open(docActive);
    const eb = pool.open(docHung);
    if (!ea || !eb) {
      throw new Error('expected entries');
    }
    const pa = await awaitAttachedPersistence(ea);
    const pb = await awaitAttachedPersistence(eb);
    pool.setActive(docActive);
    ea.observerCleanup = () => {};
    eb.observerCleanup = () => {};

    pa.clearData = mock(async () => {});
    pb.clearData = mock(() => new Promise<void>(() => {}));

    ea.provider.emit('authenticationFailed', { reason: 'server-instance-mismatch' });
    await wait(60);

    const postActive = pool.entries.get(docActive);
    if (!postActive || postActive.kind !== 'active')
      throw new Error('expected active doc post-recycle');
    expect(pool.getServerRestartRecoveryState()).toMatchObject({
      kind: 'recovering',
      phase: 'reconnecting',
      docNames: [docActive],
      failedDocNames: [docHung],
      clearFailureReason: 'clear-data-timeout',
    });

    postActive.provider.emit('synced', { state: true });

    expect(pool.getServerRestartRecoveryState()).toMatchObject({
      kind: 'failed',
      reason: 'clear-data-timeout',
      docNames: [docHung],
      failedDocNames: [docHung],
    });
  });

  // -------------------------------------------------------------------------
  // pendingClears dedup + deferred-attach + public-API swallow.
  //
  // Three coordination invariants the pool relies on for delete-then-recreate-
  // same-docName flows:
  //  - per-docName clearData dedup via a `pendingClears: Map<string, Promise>`
  //  - a `pool.open(docName)` racing an in-flight clear leaves persistence
  //    null synchronously, then attaches once the clear resolves (or skips
  //    with a structured warn if the clear rejected)
  //  - the public `closeAndClearPersistence` swallows per-docName failures so
  //    `Promise.all(...)` batches (FileTree, EditorTabs) never abort
  //
  // Each test below pins one invariant deterministically through the
  // factory-stub injection seam — no real IDB, no race timing.
  // -------------------------------------------------------------------------
  describe('pendingClears dedup + deferred-attach', () => {
    interface ControllableStub {
      stub: ClientPersistenceProvider;
      clearSpy: ReturnType<typeof mock>;
    }

    function makeControllableStub(clearImpl: () => Promise<void>): ControllableStub {
      const clearSpy = mock(clearImpl);
      const stub = {
        whenSynced: Promise.resolve(undefined as never),
        synced: true,
        destroy: mock(async () => {}),
        clearData: clearSpy,
        flushFullState: async () => {},
      } as unknown as ClientPersistenceProvider;
      return { stub, clearSpy };
    }

    test('closeAndClearPersistence dedups concurrent calls via in-flight reuse', async () => {
      // The dedup contract: a second concurrent call to closeAndClearPersistence
      // for the same docName REUSES the in-flight Promise rather than starting a
      // fresh executeCloseAndClearPersistence. clearSpy alone doesn't distinguish
      // dedup-on vs dedup-off (call 2 always finds the entry already removed by
      // call 1, so its clearData path is skipped either way). The decisive
      // observable is `indexedDB.deleteDatabase`: without dedup, call 2 falls
      // through to the IDB-by-name path and invokes it; with dedup, call 2
      // short-circuits to call 1's in-flight Promise and never reaches that path.
      let resolveClear: () => void = () => {};
      const { stub, clearSpy } = makeControllableStub(
        () =>
          new Promise<void>((resolve) => {
            resolveClear = resolve;
          }),
      );
      const persistenceFactory = mock(() => stub);
      const deleteDbSpy = spyOn(indexedDB, 'deleteDatabase');

      pool = new ProviderPool(3, DUMMY_WS, { persistenceFactory, clearDataTimeoutMs: 30_000 });
      pool.setObservedBranch('main');
      pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
      const docName = uniqueDocName('pp-pending-clears-dedup');
      const entry = pool.open(docName);
      if (!entry) throw new Error('expected entry');
      await awaitAttachedPersistence(entry);

      const deleteDbCallsBefore = deleteDbSpy.mock.calls.length;
      const call1 = pool.closeAndClearPersistence(docName);
      const call2 = pool.closeAndClearPersistence(docName);

      // clearSpy fires once on call 1's entry path. Call 2 dedups via
      // pendingClears and never enters executeCloseAndClearPersistence again.
      expect(clearSpy).toHaveBeenCalledTimes(1);
      // The decisive dedup observable: without dedup, call 2 would have
      // entered executeCloseAndClearPersistence (entry already gone), fallen
      // through to the IDB-by-name path, and invoked deleteDatabase. With
      // dedup, no second deleteDatabase call.
      expect(deleteDbSpy.mock.calls.length).toBe(deleteDbCallsBefore);

      resolveClear();
      await Promise.all([call1, call2]);
      expect(clearSpy).toHaveBeenCalledTimes(1);
      expect(deleteDbSpy.mock.calls.length).toBe(deleteDbCallsBefore);
    });

    test('deferred persistence attach: pool.open during in-flight clear leaves persistence null synchronously, attaches once clear resolves', async () => {
      let resolveClear: () => void = () => {};
      const cleared = makeControllableStub(
        () =>
          new Promise<void>((resolve) => {
            resolveClear = resolve;
          }),
      );
      const fresh = makeControllableStub(async () => {});
      let callCount = 0;
      const persistenceFactory = mock(() => {
        callCount += 1;
        return callCount === 1 ? cleared.stub : fresh.stub;
      });

      // Long timeout to avoid timing-out the never-resolves clear before we
      // resolve it manually below.
      pool = new ProviderPool(3, DUMMY_WS, { persistenceFactory, clearDataTimeoutMs: 30_000 });
      pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
      const docName = uniqueDocName('pp-pending-clears-defer-success');

      const entry1 = pool.open(docName);
      if (!entry1) throw new Error('expected entry1');
      await awaitAttachedPersistence(entry1);

      const clearPromise = pool.closeAndClearPersistence(docName);

      // Re-open during the in-flight clear — the pendingClears entry is
      // already registered (executeCloseAndClearPersistence ran its sync
      // prelude under the first call), so open() must skip persistence
      // attach and queue a deferred-attach via the `.then` on the pending
      // clear.
      const entry2 = pool.open(docName);
      if (!entry2) throw new Error('expected entry2');
      expect(entry2.persistence).toBeNull();

      resolveClear();
      await clearPromise;
      // The deferred attach routes through the stored-state validation
      // spine after the clear settles (peek of the now-empty store), so
      // the attach lands a few ticks after resolveClear().
      await waitFor(() => entry2.persistence !== null, 2_000);
      expect(entry2.persistence).toBe(fresh.stub);
    });

    test('deferred persistence attach skipped on pending-clear-failed (structured warn fires, persistence stays null)', async () => {
      let rejectClear: (err: Error) => void = () => {};
      const cleared = makeControllableStub(
        () =>
          new Promise<void>((_, reject) => {
            rejectClear = reject;
          }),
      );
      const persistenceFactory = mock(() => cleared.stub);

      pool = new ProviderPool(3, DUMMY_WS, { persistenceFactory, clearDataTimeoutMs: 30_000 });
      pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
      const docName = uniqueDocName('pp-pending-clears-defer-fail');

      const entry1 = pool.open(docName);
      if (!entry1) throw new Error('expected entry1');
      await awaitAttachedPersistence(entry1);
      const clearPromise = pool.closeAndClearPersistence(docName);

      const entry2 = pool.open(docName);
      if (!entry2) throw new Error('expected entry2');
      expect(entry2.persistence).toBeNull();

      const warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        rejectClear(new Error('idb-clear-blocked'));
        // closeAndClearPersistence's public API swallows the reject; the
        // pending-clear promise the deferred-attach .then subscribes to is
        // the INTERNAL one (runCloseAndClearPersistence), which rejects.
        await clearPromise;
        await wait(0);

        const skippedWarn = warnSpy.mock.calls
          .map((call) => String(call[0] ?? ''))
          .find((s) => s.includes('"event":"ok-pool-deferred-persistence-attach-skipped"'));
        expect(skippedWarn).toBeDefined();
        expect(skippedWarn).toContain('"reason":"pending-clear-failed"');
        expect(entry2.persistence).toBeNull();
      } finally {
        warnSpy.mockRestore();
      }
    });

    test('dispose() clears pendingClears tracking so the deferred-attach .then never reattaches', async () => {
      let resolveClear: () => void = () => {};
      const cleared = makeControllableStub(
        () =>
          new Promise<void>((resolve) => {
            resolveClear = resolve;
          }),
      );
      const fresh = makeControllableStub(async () => {});
      let callCount = 0;
      const persistenceFactory = mock(() => {
        callCount += 1;
        return callCount === 1 ? cleared.stub : fresh.stub;
      });

      pool = new ProviderPool(3, DUMMY_WS, { persistenceFactory, clearDataTimeoutMs: 30_000 });
      pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
      const docName = uniqueDocName('pp-pending-clears-dispose');
      const entry1 = pool.open(docName);
      if (!entry1) throw new Error('expected entry1');
      await awaitAttachedPersistence(entry1);

      const clearPromise = pool.closeAndClearPersistence(docName);
      const entry2 = pool.open(docName);
      if (!entry2) throw new Error('expected entry2');
      expect(entry2.persistence).toBeNull();

      pool.dispose();
      resolveClear();
      await clearPromise;
      await wait(0);

      // The .then handler inside attachDeferredPersistenceForEntry guards on
      // `_entries.get(docName) !== entry` — after dispose's clear that guard
      // short-circuits, so no attachDeferredPersistenceForEntry side effect
      // fires. We observe this by asserting the fresh stub was NEVER
      // constructed (factory was only called once, for the original open).
      expect(persistenceFactory).toHaveBeenCalledTimes(1);
      expect(entry2.persistence).toBeNull();
    });

    test('Promise.all batch over closeAndClearPersistence resolves even when one inner clearData rejects', async () => {
      // Public-API swallow contract: FileTree/EditorTabs cleanup batches many
      // close-and-clears via `Promise.all(...)`. One IDB-blocker rejection
      // must not abort the batch. This is the trust-boundary swallow inside
      // closeAndClearPersistence's public wrapper.
      const ok1 = makeControllableStub(async () => {});
      const fail = makeControllableStub(() => Promise.reject(new Error('idb-failed')));
      const ok2 = makeControllableStub(async () => {});
      const stubs = [ok1.stub, fail.stub, ok2.stub];
      let idx = 0;
      const persistenceFactory = mock(() => {
        const s = stubs[idx];
        idx += 1;
        return s;
      });

      pool = new ProviderPool(3, DUMMY_WS, { persistenceFactory });
      pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
      const docs = [
        uniqueDocName('pp-swallow-ok1'),
        uniqueDocName('pp-swallow-fail'),
        uniqueDocName('pp-swallow-ok2'),
      ];
      for (const d of docs) {
        const entry = pool.open(d);
        if (!entry) throw new Error('expected entry');
        await awaitAttachedPersistence(entry);
      }

      const warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        await Promise.all(docs.map((d) => pool.closeAndClearPersistence(d)));
        // Each entry's clearData was attempted.
        expect(ok1.clearSpy).toHaveBeenCalledTimes(1);
        expect(fail.clearSpy).toHaveBeenCalledTimes(1);
        expect(ok2.clearSpy).toHaveBeenCalledTimes(1);
      } finally {
        warnSpy.mockRestore();
      }
    });

    test('non-concurrent reopen after a failed clear retries the IDB clear before attaching fresh persistence', async () => {
      // The silent-regression contract this test pins: when the public
      // `closeAndClearPersistence` swallows a clearData rejection, the
      // failure must NOT be forgotten by the time `pendingClears` drains.
      // A later non-concurrent `pool.open(docName)` for the same name has
      // to re-trigger the IDB clear and defer persistence attachment until
      // the retry settles. Without the retry, the fresh provider hydrates
      // its Y.Doc from the still-stale IDB rows — exactly the cross-doc
      // content-bleed class the rename clear path exists to prevent.
      const failedStub = makeControllableStub(() => Promise.reject(new Error('idb-blocked')));
      const freshStub = makeControllableStub(async () => {});
      let factoryCallCount = 0;
      const persistenceFactory = mock(() => {
        factoryCallCount += 1;
        return factoryCallCount === 1 ? failedStub.stub : freshStub.stub;
      });

      pool = new ProviderPool(3, DUMMY_WS, { persistenceFactory, clearDataTimeoutMs: 30_000 });
      pool.setObservedBranch('main');
      pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
      const docName = uniqueDocName('pp-clearfail-retry');

      const entry1 = pool.open(docName);
      if (!entry1) throw new Error('expected entry1');
      await awaitAttachedPersistence(entry1);

      const deleteDbSpy = spyOn(indexedDB, 'deleteDatabase');
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const baselineDeleteCalls = deleteDbSpy.mock.calls.length;

        // First close-and-clear: clearData rejects. The public wrapper
        // swallows so the caller sees success; the pendingClears finalize
        // epilogue runs and the docName drops out of pendingClears.
        await pool.closeAndClearPersistence(docName);
        // Microtask drain so the .then(finalize, finalize) epilogue runs
        // before the next open() observes pendingClears state.
        await wait(0);

        // Non-concurrent reopen of the same docName. Without the retry
        // path, the open() builds fresh persistence synchronously against
        // an IDB whose rows from the prior session were never cleared.
        const entry2 = pool.open(docName);
        if (!entry2) throw new Error('expected entry2');

        // Synchronous post-condition: open() recognized the prior clear
        // failure and deferred persistence attachment behind a retry. A
        // synchronous attach here would mean the retry path didn't fire.
        expect(entry2.persistence).toBeNull();

        // The retry path runs the canonical IDB-by-name delete (the same
        // primitive the non-pool branch of executeCloseAndClearPersistence
        // uses), so the docName's IDB is targeted explicitly.
        const retryDbName = `ok-ydoc:main:${TEST_SERVER_INSTANCE_ID}:${docName}`;
        expect(deleteDbSpy.mock.calls.length).toBeGreaterThan(baselineDeleteCalls);
        expect(deleteDbSpy.mock.calls.some((call) => call[0] === retryDbName)).toBe(true);

        // Once the retry resolves against fake-indexeddb, the existing
        // deferred-attach scheduler attaches the fresh persistence.
        const attached = await waitFor(() => entry2.persistence !== null, 2_000);
        expect(attached).toBe(true);
        expect(entry2.persistence).toBe(freshStub.stub);
      } finally {
        warnSpy.mockRestore();
        deleteDbSpy.mockRestore();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// MECHANISM-ONLY tests for buffer-and-replay. These
// assert the state-vector capture + TAB_REPLAY_ORIGIN path. The end-to-end
// behavior (burst survives mismatch-recycle) is covered by the
// integration suite in `packages/app/tests/integration/`.
// ---------------------------------------------------------------------------
describe('ProviderPool buffer-and-replay (US-004)', () => {
  test('captures the last server-synced state vector on every synced event', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open(uniqueDocName('pp-sv'));
    if (!entry) throw new Error('expected entry');
    // Pre-set observerCleanup so onSynced skips setupObservers
    entry.observerCleanup = () => {};
    expect(entry.lastServerSyncedSV).toBeNull();

    entry.provider.emit('synced', { state: true });
    expect(entry.lastServerSyncedSV).toBeInstanceOf(Uint8Array);
  });

  test('TAB_REPLAY_ORIGIN is a stable frozen object', async () => {
    const mod = await import('./provider-pool');
    expect(mod.TAB_REPLAY_ORIGIN.kind).toBe('tab-replay');
    expect(Object.isFrozen(mod.TAB_REPLAY_ORIGIN)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Disk-ack watermark tests. Validates that
// `observeDiskAck` advances the per-entry slot and that
// `handleServerInstanceMismatch` prefers it over `lastServerSyncedSV` when
// computing the recycle buffer baseline. The end-to-end behavior is covered
// by the integration test `mid-drain-restart.test.ts`.
// ---------------------------------------------------------------------------
describe('ProviderPool observeDiskAck (disk-ack watermark)', () => {
  test('advances lastDiskAckedSV on the active entry', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const docName = uniqueDocName('pp-dack');
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    expect(entry.lastDiskAckedSV).toBeNull();

    const sv = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    pool.observeDiskAck(docName, sv);
    expect(entry.lastDiskAckedSV).toBe(sv);
  });

  test('advances on subsequent observe with a strictly-newer SV', async () => {
    // Use real Yjs-encoded SVs so the element-wise max-merge has valid
    // structure to decode. Synthetic byte arrays would fail the
    // decode step inside `mergeStateVectors`.
    const Y = await import('yjs');
    pool = new ProviderPool(3, DUMMY_WS);
    const docName = uniqueDocName('pp-dack');
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');

    const doc = new Y.Doc();
    doc.getText('t').insert(0, 'A');
    const svAfterA = Y.encodeStateVector(doc);
    doc.getText('t').insert(1, 'B');
    const svAfterAB = Y.encodeStateVector(doc);
    doc.destroy();

    pool.observeDiskAck(docName, svAfterA);
    pool.observeDiskAck(docName, svAfterAB);
    expect(entry.lastDiskAckedSV).toEqual(svAfterAB);
  });

  // Out-of-order receive across two channels (CC1 WS + /api/server-info
  // HTTP): a slow HTTP response can land AFTER a newer WS broadcast. A
  // pure overwrite-on-receive would regress lastDiskAckedSV from the
  // newer WS value to the older HTTP value, reopening the disk-ack
  // staleness duplication path. Element-wise max-merge protects
  // against this by keeping the larger clock per clientID.
  test('does NOT regress on out-of-order observe with a strictly-older SV', async () => {
    const Y = await import('yjs');
    pool = new ProviderPool(3, DUMMY_WS);
    const docName = uniqueDocName('pp-dack');
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');

    const doc = new Y.Doc();
    doc.getText('t').insert(0, 'A');
    const svAfterA = Y.encodeStateVector(doc);
    doc.getText('t').insert(1, 'B');
    const svAfterAB = Y.encodeStateVector(doc);
    doc.destroy();

    // Newer SV arrives first (live WS broadcast), older SV arrives
    // second (stale HTTP response). Merge keeps the newer.
    pool.observeDiskAck(docName, svAfterAB);
    pool.observeDiskAck(docName, svAfterA);
    expect(entry.lastDiskAckedSV).toEqual(svAfterAB);
  });

  test('no-op when entry does not exist for docName', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    // No entry for 'nonexistent-doc' — must not throw.
    expect(() => {
      pool.observeDiskAck('nonexistent-doc', new Uint8Array([1, 2, 3]));
    }).not.toThrow();
  });

  test('no-op when entry has been removed from the pool', async () => {
    // After `pool.close(docName)` runs synchronously
    // (`destroyEntry` + `entries.delete`), `observeDiskAck`'s
    // `this.entries.get(docName)` returns undefined and hits the
    // `!entry` early-return. The `kind !== 'active'` branch is
    // defensive code for closure-stale calls inside `destroyEntry`'s
    // synchronous critical section — unreachable from any external
    // caller in normal operation, since the pool's external API
    // transitions an entry from `active` to `(gone)` atomically.
    pool = new ProviderPool(3, DUMMY_WS);
    const docName = uniqueDocName('pp-dack');
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    const initialSV = new Uint8Array([0xab]);
    pool.observeDiskAck(docName, initialSV);

    pool.close(docName);
    // After close, the entry is gone from `this.entries`. A subsequent
    // observeDiskAck must NOT mutate any future entry's state.
    pool.observeDiskAck(docName, new Uint8Array([0xcd]));
    // Re-opening yields a fresh entry with null watermark — proves
    // the post-close call did not leak into a future entry.
    const fresh = pool.open(docName);
    if (!fresh) throw new Error('expected fresh entry');
    expect(fresh.lastDiskAckedSV).toBeNull();
  });
});

describe('ProviderPool observeDiskAckBatch (missed-frame recovery)', () => {
  test('updates lastDiskAckedSV for every doc named in the batch', async () => {
    const Y = await import('yjs');
    pool = new ProviderPool(3, DUMMY_WS);
    const docA = uniqueDocName('pp-batch');
    const docB = uniqueDocName('pp-batch');
    const entryA = pool.open(docA);
    const entryB = pool.open(docB);
    if (!entryA || !entryB) throw new Error('expected entries');

    const yDocA = new Y.Doc();
    yDocA.getText('t').insert(0, 'A');
    const svA = Y.encodeStateVector(yDocA);
    yDocA.destroy();
    const yDocB = new Y.Doc();
    yDocB.getText('t').insert(0, 'BB');
    const svB = Y.encodeStateVector(yDocB);
    yDocB.destroy();

    pool.observeDiskAckBatch({ [docA]: svA, [docB]: svB });

    expect(entryA.lastDiskAckedSV).toEqual(svA);
    expect(entryB.lastDiskAckedSV).toEqual(svB);
  });

  test('silently ignores docs in the batch that the pool does not have open', async () => {
    const Y = await import('yjs');
    pool = new ProviderPool(3, DUMMY_WS);
    const docA = uniqueDocName('pp-batch');
    const entryA = pool.open(docA);
    if (!entryA) throw new Error('expected entry');

    const yDoc = new Y.Doc();
    yDoc.getText('t').insert(0, 'X');
    const sv = Y.encodeStateVector(yDoc);
    yDoc.destroy();

    expect(() => {
      pool.observeDiskAckBatch({
        [docA]: sv,
        'nonexistent-doc': sv,
      });
    }).not.toThrow();
    expect(entryA.lastDiskAckedSV).toEqual(sv);
  });

  test('empty batch is a no-op', async () => {
    const Y = await import('yjs');
    pool = new ProviderPool(3, DUMMY_WS);
    const docA = uniqueDocName('pp-batch');
    const entryA = pool.open(docA);
    if (!entryA) throw new Error('expected entry');

    const yDoc = new Y.Doc();
    yDoc.getText('t').insert(0, 'A');
    const sv = Y.encodeStateVector(yDoc);
    yDoc.destroy();
    pool.observeDiskAck(docA, sv);

    pool.observeDiskAckBatch({});
    expect(entryA.lastDiskAckedSV).toEqual(sv);
  });

  // Late-join recovery contract: after a __system__ reconnect, the
  // batch refresh MUST advance a stale per-entry watermark to the
  // server's authoritative value. The merge guarantees this when the
  // batch carries a strictly-newer SV.
  test('advances a stale lastDiskAckedSV when the batch carries a strictly-newer SV', async () => {
    const Y = await import('yjs');
    pool = new ProviderPool(3, DUMMY_WS);
    const docA = uniqueDocName('pp-batch');
    const entryA = pool.open(docA);
    if (!entryA) throw new Error('expected entry');

    const yDoc = new Y.Doc();
    yDoc.getText('t').insert(0, 'A');
    const stale = Y.encodeStateVector(yDoc);
    yDoc.getText('t').insert(1, 'B');
    const fresh = Y.encodeStateVector(yDoc);
    yDoc.destroy();

    pool.observeDiskAck(docA, stale);
    pool.observeDiskAckBatch({ [docA]: fresh });
    expect(entryA.lastDiskAckedSV).toEqual(fresh);
  });

  // Cross-channel out-of-order receive contract: a batch refresh MUST
  // NOT regress a per-entry watermark when the batch carries an
  // older SV than what's already there. This is the WS+HTTP race
  // the merge-on-receive policy exists to defuse — the live broadcast
  // landed first, the stale HTTP response landed second, and the
  // merged result keeps the live broadcast's clocks.
  test('does NOT regress a current lastDiskAckedSV when the batch carries an older SV', async () => {
    const Y = await import('yjs');
    pool = new ProviderPool(3, DUMMY_WS);
    const docA = uniqueDocName('pp-batch');
    const entryA = pool.open(docA);
    if (!entryA) throw new Error('expected entry');

    const yDoc = new Y.Doc();
    yDoc.getText('t').insert(0, 'A');
    const olderSV = Y.encodeStateVector(yDoc);
    yDoc.getText('t').insert(1, 'B');
    const newerSV = Y.encodeStateVector(yDoc);
    yDoc.destroy();

    // WS broadcast lands first with newer SV; HTTP batch arrives
    // afterwards with older SV. Merged result keeps newer.
    pool.observeDiskAck(docA, newerSV);
    pool.observeDiskAckBatch({ [docA]: olderSV });
    expect(entryA.lastDiskAckedSV).toEqual(newerSV);
  });
});

describe('ProviderPool handleServerInstanceMismatch baseline-selection', () => {
  // These tests assert the conservative-watermark logic: when
  // `lastDiskAckedSV` is set, it MUST be used as the baseline for the
  // unsynced-buffer computation (not `lastServerSyncedSV`) — disk-ack'd
  // updates will survive the markdown rebuild on server-restart, so they
  // don't need to be replayed (and replaying them is what causes the
  // mid-drain duplication).

  test('handleServerInstanceMismatch uses lastDiskAckedSV when present', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      pool = new ProviderPool(3, DUMMY_WS);
      pool.setExpectedServerInstanceId('server-old');
      const docName = uniqueDocName('pp-baseline');
      const entry = pool.open(docName);
      if (!entry) throw new Error('expected entry');
      pool.setActive(docName);
      entry.observerCleanup = () => {};

      // Two-phase baseline construction. Phase A's content is "already on
      // disk + already in server memory" (both watermarks would advance
      // past it under normal flow). Phase B is "in-memory-only" (server
      // hasn't received the disk-ack yet).
      const Y = await import('yjs');
      const cp = await import('./client-persistence');
      entry.provider.document.getText('source').insert(0, 'AAA');
      const svAfterAAA = cp.captureStateVector(entry.provider.document);
      entry.provider.document.getText('source').insert(3, 'BBB');
      const svAfterAAABBB = cp.captureStateVector(entry.provider.document);
      entry.provider.document.getText('source').insert(6, 'CCC');

      // Set both SVs explicitly. lastDiskAckedSV (more conservative —
      // server has durably persisted only 'AAA') must win as baseline.
      entry.lastDiskAckedSV = svAfterAAA;
      entry.lastServerSyncedSV = svAfterAAABBB;

      entry.provider.emit('authenticationFailed', { reason: 'server-instance-mismatch' });
      await wait(100);

      const noBaselineSkipped = warnSpy.mock.calls.filter(([first]) => {
        if (typeof first !== 'string') return false;
        try {
          return JSON.parse(first).event === 'ok-buffer-replay-skipped-no-baseline';
        } catch {
          return false;
        }
      }).length;

      const buffered = pool.__test_getBufferedUpdate(docName);
      if (!buffered) throw new Error('expected buffered update for active doc');

      expect(noBaselineSkipped).toBe(0);

      // The buffered update MUST equal the unsynced-from-disk-ack delta
      // (covering 'BBB' + 'CCC'), NOT the unsynced-from-server-synced
      // delta (covering only 'CCC'). Compare byte-identity to encodeStateAsUpdate
      // computed independently — proves which baseline was used.
      const expected = Y.encodeStateAsUpdate(entry.provider.document, svAfterAAA);
      expect(buffered).toEqual(expected);

      // Sanity: the alternative baseline produces a DIFFERENT (shorter) update.
      const wrong = Y.encodeStateAsUpdate(entry.provider.document, svAfterAAABBB);
      expect(buffered.byteLength).toBeGreaterThan(wrong.byteLength);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('handleServerInstanceMismatch falls back to lastServerSyncedSV when lastDiskAckedSV is null', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setExpectedServerInstanceId('server-old');
    const docName = uniqueDocName('pp-baseline');
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    pool.setActive(docName);
    entry.observerCleanup = () => {};

    const Y = await import('yjs');
    const cp = await import('./client-persistence');
    entry.provider.document.getText('source').insert(0, 'AAA');
    const svAfterAAA = cp.captureStateVector(entry.provider.document);
    entry.provider.document.getText('source').insert(3, 'BBB');

    // Cold-connect window: server-synced advanced normally; disk-ack
    // never arrived (server crashed before flush). Pool falls back to
    // lastServerSyncedSV.
    entry.lastServerSyncedSV = svAfterAAA;
    expect(entry.lastDiskAckedSV).toBeNull();

    entry.provider.emit('authenticationFailed', { reason: 'server-instance-mismatch' });
    await wait(100);

    const buffered = pool.__test_getBufferedUpdate(docName);
    if (!buffered) throw new Error('expected buffered update');

    const expected = Y.encodeStateAsUpdate(entry.provider.document, svAfterAAA);
    expect(buffered).toEqual(expected);
  });

  test('handleServerInstanceMismatch skips buffer replay when both watermark SVs are null', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      pool = new ProviderPool(3, DUMMY_WS);
      pool.setExpectedServerInstanceId('server-old');
      pool.setObservedBranch('no-baseline-branch');
      const docName = uniqueDocName('pp-baseline');
      const entry = pool.open(docName);
      if (!entry) throw new Error('expected entry');
      pool.setActive(docName);

      entry.provider.document.getText('source').insert(0, 'unacked content');
      expect(entry.lastServerSyncedSV).toBeNull();
      expect(entry.lastDiskAckedSV).toBeNull();

      entry.provider.emit('authenticationFailed', { reason: 'server-instance-mismatch' });
      await wait(100);

      // No trusted baseline → no in-memory replay buffer; clearData + recycle still run downstream.
      expect(pool.__test_getBufferedUpdate(docName)).toBeUndefined();

      const noBaselineCalls = warnSpy.mock.calls.filter(([first]) => {
        if (typeof first !== 'string') return false;
        try {
          return JSON.parse(first).event === 'ok-buffer-replay-skipped-no-baseline';
        } catch {
          return false;
        }
      });
      expect(noBaselineCalls.length).toBe(1);
      const firstArg = noBaselineCalls[0]?.[0];
      expect(typeof firstArg).toBe('string');
      const payload = JSON.parse(firstArg) as {
        event: string;
        docName: string;
        branch: string;
        serverInstanceId: string;
        reason: string;
      };
      expect(payload.event).toBe('ok-buffer-replay-skipped-no-baseline');
      expect(payload.docName).toBe(docName);
      expect(payload.branch).toBe('no-baseline-branch');
      expect(payload.serverInstanceId).toBe('server-old');
      expect(payload.reason).toBe('no-disk-ack-or-server-sync-vector');
      expect(new Set(Object.keys(payload))).toEqual(
        new Set(['event', 'docName', 'branch', 'serverInstanceId', 'reason']),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

/**
 * Persistence tripwire blocks emit `ok-persistence-duplication-blocked` server-side only.
 * There is no push channel delivering that signal to browsers, so
 * ServerRestartRecoveryState does not expose a duplicated-write sentinel—the
 * existing mismatch recovery spinner / failed-clear states remain the UX surface for
 * client-observable cache recovery.
 */
describe('ProviderPool structured mismatch telemetry', () => {
  test('replay applies corrupt buffer emits ok-buffer-replay-failed with bounded fields', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      pool = new ProviderPool(3, DUMMY_WS);
      pool.setExpectedServerInstanceId('epoch-replay-telemetry');
      pool.setObservedBranch('replay-telemetry-branch');
      const docName = uniqueDocName('replay-flush');
      const entry = pool.open(docName);
      if (!entry) throw new Error('expected entry');
      await awaitAttachedPersistence(entry);
      pool.setActive(docName);
      entry.observerCleanup = () => {};

      const cp = await import('./client-persistence');
      entry.provider.document.getText('source').insert(0, 'R');
      const svDisk = cp.captureStateVector(entry.provider.document);
      entry.lastDiskAckedSV = svDisk;

      entry.provider.emit('authenticationFailed', { reason: 'server-instance-mismatch' });
      await wait(150);

      const neo = pool.entries.get(docName);
      if (!neo || neo.kind !== 'active') throw new Error('expected recycled active entry');

      neo.observerCleanup = () => {};
      pool.__test_seedBufferedUpdate(docName, new Uint8Array([255, 0, 254]));
      neo.provider.emit('synced', { state: true });

      await wait(20);

      const replayFailedCalls = warnSpy.mock.calls
        .map((c) => c[0])
        .filter((first): first is string => typeof first === 'string')
        .filter((first) => {
          try {
            return JSON.parse(first).event === 'ok-buffer-replay-failed';
          } catch {
            return false;
          }
        });
      expect(replayFailedCalls.length).toBe(1);
      const payload = JSON.parse(replayFailedCalls[0] ?? '{}') as {
        event: string;
        docName: string;
        branch: string;
        serverInstanceId?: string;
        replayByteLength: number;
        errorName: string;
        errorMessage: string;
      };
      expect(payload.event).toBe('ok-buffer-replay-failed');
      expect(payload.docName).toBe(docName);
      expect(payload.branch).toBe('replay-telemetry-branch');
      expect(payload.serverInstanceId).toBe('epoch-replay-telemetry');
      expect(payload.replayByteLength).toBe(3);
      expect(typeof payload.errorName).toBe('string');
      expect(typeof payload.errorMessage).toBe('string');
      expect(new Set(Object.keys(payload))).toEqual(
        new Set([
          'event',
          'docName',
          'branch',
          'serverInstanceId',
          'replayByteLength',
          'errorName',
          'errorMessage',
        ]),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('epoch mismatch envelope uses active doc plus branch and stale instance claim', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      pool = new ProviderPool(3, DUMMY_WS);
      pool.setExpectedServerInstanceId('stale-epoch-telemetry');
      pool.setObservedBranch('epoch-msg-branch');
      const docName = uniqueDocName('epoch-msg');
      const entry = pool.open(docName);
      if (!entry) throw new Error('expected entry');
      pool.setActive(docName);

      entry.provider.emit('authenticationFailed', { reason: 'server-instance-mismatch' });
      await wait(30);

      const epochCalls = warnSpy.mock.calls
        .map((c) => c[0])
        .filter((first): first is string => typeof first === 'string')
        .filter((first) => {
          try {
            return JSON.parse(first).event === 'ok-client-cache-epoch-mismatch';
          } catch {
            return false;
          }
        });
      expect(epochCalls.length).toBe(1);
      const payload = JSON.parse(epochCalls[0] ?? '{}') as {
        event: string;
        docName: string;
        branch: string;
        serverInstanceId: string;
      };
      expect(payload.docName).toBe(docName);
      expect(payload.branch).toBe('epoch-msg-branch');
      expect(payload.serverInstanceId).toBe('stale-epoch-telemetry');
      expect(new Set(Object.keys(payload))).toEqual(
        new Set(['event', 'docName', 'branch', 'serverInstanceId']),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('recovery state machine never reports blocked-suspicious-write labels', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const snapshot = JSON.stringify(pool.getServerRestartRecoveryState());
    expect(snapshot).not.toContain('blocked-suspicious-write');
    expect(snapshot).not.toContain('blocked_suspicious_write');
  });
});

// ---------------------------------------------------------------------------
// Provider-open gating: persistent IndexedDB attachment is deferred until
// `setExpectedServerInstanceId` lands a non-null id. Until then,
// `entry.persistence` is null and no DB handle is opened — preventing an
// "unknown-epoch" DB from being created against a name the next session
// could re-attach to. Once the id arrives, `attachDeferredPersistence`
// retroactively wires up persistence on every active entry that was opened
// during the cold-boot window.
// ---------------------------------------------------------------------------
describe('ProviderPool provider-open gating', () => {
  test('whenServerInstanceKnown resolves immediately when id is already cached', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
    expect(await pool.whenServerInstanceKnown()).toBe(TEST_SERVER_INSTANCE_ID);
  });

  test('whenServerInstanceKnown returns the same pending promise for concurrent callers', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const p1 = pool.whenServerInstanceKnown();
    const p2 = pool.whenServerInstanceKnown();
    expect(p1).toBe(p2);
  });

  test('whenServerInstanceKnown resolves once setExpectedServerInstanceId lands a non-null id', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const pending = pool.whenServerInstanceKnown();
    pool.setExpectedServerInstanceId('server-cold-boot');
    expect(await pending).toBe('server-cold-boot');
  });

  test('setExpectedServerInstanceId(null) does not reject pending whenServerInstanceKnown', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const pending = pool.whenServerInstanceKnown();
    pool.setExpectedServerInstanceId(null);
    pool.setExpectedServerInstanceId('server-after-null');
    expect(await pending).toBe('server-after-null');
  });

  test('a previously-resolved whenServerInstanceKnown promise is not re-resolved on a later id change', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setExpectedServerInstanceId('server-first');
    const resolved = await pool.whenServerInstanceKnown();
    expect(resolved).toBe('server-first');
    pool.setExpectedServerInstanceId('server-second');
    // Fresh call observes the new id; the previously-resolved value is stable.
    expect(await pool.whenServerInstanceKnown()).toBe('server-second');
    expect(resolved).toBe('server-first');
  });

  test('open() before serverInstanceId is known does not construct a stale-shape IDB database', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setObservedBranch('main');
    const docName = uniqueDocName('pp-cold-boot');
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    expect(entry.persistence).toBeNull();
    expect(entry.kind).toBe('active');

    if (typeof indexedDB !== 'undefined') {
      const dbs = await indexedDB.databases();
      const staleShapeName = `ok-ydoc:main:${docName}`;
      const newShapeUnknownEpoch = `ok-ydoc:main::${docName}`;
      expect(dbs.find((d) => d.name === staleShapeName)).toBeUndefined();
      expect(dbs.find((d) => d.name === newShapeUnknownEpoch)).toBeUndefined();
    }
  });

  test('setExpectedServerInstanceId retroactively attaches persistence with the new-shape DB name', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setObservedBranch('main');
    const docA = uniqueDocName('pp-retro');
    const docB = uniqueDocName('pp-retro');
    const entryA = pool.open(docA);
    const entryB = pool.open(docB);
    if (!entryA || !entryB) throw new Error('expected entries');
    expect(entryA.persistence).toBeNull();
    expect(entryB.persistence).toBeNull();

    pool.setExpectedServerInstanceId('server-retro-attach');

    if (entryA.kind !== 'active' || entryB.kind !== 'active') {
      throw new Error('expected entries to remain active');
    }
    await awaitAttachedPersistence(entryA);
    await awaitAttachedPersistence(entryB);
    expect(entryA.persistence).not.toBeNull();
    expect(entryB.persistence).not.toBeNull();
    expect(typeof entryA.persistence?.destroy).toBe('function');
    expect(typeof entryA.persistence?.clearData).toBe('function');

    if (typeof indexedDB !== 'undefined') {
      await entryA.persistence?.whenSynced;
      await entryB.persistence?.whenSynced;
      const dbs = await indexedDB.databases();
      const names = new Set(dbs.map((d) => d.name).filter((n): n is string => n !== undefined));
      expect(names.has(`ok-ydoc:main:server-retro-attach:${docA}`)).toBe(true);
      expect(names.has(`ok-ydoc:main:server-retro-attach:${docB}`)).toBe(true);
      // Stale-shape (no epoch slot) and unknown-epoch (empty epoch slot)
      // databases must NOT be created during the cold-boot window.
      expect(names.has(`ok-ydoc:main:${docA}`)).toBe(false);
      expect(names.has(`ok-ydoc:main::${docA}`)).toBe(false);
    }
  });

  test('setExpectedServerInstanceId is a no-op for entries that already have persistence attached', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setExpectedServerInstanceId('server-warm');
    const docName = uniqueDocName('pp-warm');
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    const persistenceBefore = await awaitAttachedPersistence(entry);

    pool.setExpectedServerInstanceId('server-warm-update');
    await wait(20);
    if (entry.kind !== 'active') throw new Error('expected entry to remain active');
    expect(entry.persistence).toBe(persistenceBefore);
  });

  test('setExpectedServerInstanceId(null) does not detach already-attached persistence', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setExpectedServerInstanceId('server-warm');
    const docName = uniqueDocName('pp-no-detach');
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    const persistenceBefore = await awaitAttachedPersistence(entry);

    pool.setExpectedServerInstanceId(null);
    await wait(20);
    if (entry.kind !== 'active') throw new Error('expected entry to remain active');
    expect(entry.persistence).toBe(persistenceBefore);
  });

  test('dispose() drops the pending whenServerInstanceKnown handle', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const pending = pool.whenServerInstanceKnown();
    pool.dispose();

    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await wait(10);
    expect(settled).toBe(false);

    // Re-create the pool so the afterEach dispose() targets a real instance.
    pool = new ProviderPool(3, DUMMY_WS);
  });
});

describe('ProviderPool authenticationFailed: rename-redirect / doc-deleted', () => {
  const emit = (entry: { provider: unknown }, reason: string) => {
    (entry.provider as { emit: (e: string, p: unknown) => void }).emit('authenticationFailed', {
      reason,
    });
  };

  test("'rename-redirect:foo' parses payload and invokes onRenameRedirect", () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const calls: { fromDocName: string; toDocName: string; hadOpenProvider: boolean }[] = [];
    pool.setOnRenameRedirect((args) => calls.push(args));
    const entry = pool.open('doc-from');
    if (!entry) throw new Error('expected entry');
    emit(entry, 'rename-redirect:doc-to');
    expect(calls).toEqual([
      { fromDocName: 'doc-from', toDocName: 'doc-to', hadOpenProvider: true },
    ]);
  });

  test("'rename-redirect' with payload containing colon round-trips on first colon only", () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const calls: { toDocName: string }[] = [];
    pool.setOnRenameRedirect((args) => calls.push({ toDocName: args.toDocName }));
    const entry = pool.open('a');
    if (!entry) throw new Error('expected entry');
    emit(entry, 'rename-redirect:has:colon/in/path');
    expect(calls[0]?.toDocName).toBe('has:colon/in/path');
  });

  test("'rename-redirect' with empty payload warns and skips cleanup", () => {
    pool = new ProviderPool(3, DUMMY_WS);
    let cleanupCalled = 0;
    pool.setOnRenameRedirect(() => {
      cleanupCalled++;
    });
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (msg: unknown) => warns.push(String(msg));
    try {
      const entry = pool.open('doc-x');
      if (!entry) throw new Error('expected entry');
      emit(entry, 'rename-redirect');
      emit(entry, 'rename-redirect:');
    } finally {
      console.warn = orig;
    }
    expect(cleanupCalled).toBe(0);
    const matched = warns.filter((w) => w.includes('rename-redirect-missing-payload'));
    expect(matched.length).toBe(2);
  });

  test("'doc-deleted' invokes onDocDeleted with hadOpenProvider true when entry is active", () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const calls: { docName: string; hadOpenProvider: boolean }[] = [];
    pool.setOnDocDeleted((args) => calls.push(args));
    const entry = pool.open('doc-z');
    if (!entry) throw new Error('expected entry');
    emit(entry, 'doc-deleted');
    expect(calls).toEqual([{ docName: 'doc-z', hadOpenProvider: true }]);
  });

  test("server-driven 'close' triggers a fresh sendToken so onAuthenticate can re-run", () => {
    // Hocuspocus' `Connection.close()` (server) sends an application-level
    // CloseMessage frame; the multiplex WS stays open. Without intervention
    // the provider's `isAuthenticated` flips false but no fresh auth is
    // sent — `forceSync` queues frames forever in the server's
    // `incomingMessageQueue`. The pool's `'close'` handler calls
    // `sendToken()` so the server runs `onAuthenticate` again, where the
    // `removalRedirectGuard` extension turns the close into an
    // `'authenticationFailed'` with `'rename-redirect'` or `'doc-deleted'`.
    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open('doc-close');
    if (!entry) throw new Error('expected entry');
    const provider = entry.provider as {
      sendToken: () => Promise<void>;
      emit: (e: string, p: unknown) => void;
    };
    const sendTokenSpy = spyOn(provider, 'sendToken').mockResolvedValue();
    // Discard any sendToken calls from the provider's own `onOpen` boot
    // path so the assertion below only counts the close-handler-driven
    // call. The pool's interest is in the handler's behavior, not the
    // initial-handshake call.
    sendTokenSpy.mockClear();
    provider.emit('close', { event: { code: 1000, reason: 'Server closed the connection' } });
    expect(sendTokenSpy).toHaveBeenCalledTimes(1);
  });

  test("server-driven 'close' followed by sendToken rejection emits a structured warn", async () => {
    // Coverage for the failure mode that doesn't surface as
    // `'authenticationFailed'` (transport already closed, token resolver
    // throws synchronously, network unreachable). The empty-catch shape
    // would silently swallow these and leave operators with no diagnostic
    // trace when an active tab fails to remap after rename.
    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open('doc-warn');
    if (!entry) throw new Error('expected entry');
    const provider = entry.provider as {
      sendToken: () => Promise<void>;
      emit: (e: string, p: unknown) => void;
    };
    const sendTokenSpy = spyOn(provider, 'sendToken').mockRejectedValue(
      new Error('synthetic transport-closed failure'),
    );
    sendTokenSpy.mockClear();
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warns.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
    try {
      provider.emit('close', { event: { code: 1000, reason: 'rename-driven' } });
      // Wait for the rejection microtask + .catch to settle.
      await waitFor(
        () => warns.some((w) => w.includes('ok-provider-server-driven-close-reauth-failed')),
        500,
      );
      const matched = warns.filter((w) =>
        w.includes('ok-provider-server-driven-close-reauth-failed'),
      );
      expect(matched.length).toBeGreaterThanOrEqual(1);
      expect(matched[0]).toContain('"docName":"doc-warn"');
      expect(matched[0]).toContain('synthetic transport-closed failure');
    } finally {
      console.warn = originalWarn;
    }
  });

  test("burst of server-driven 'close' frames during in-flight sendToken does not stack parallel auths", () => {
    // A burst of close frames (e.g., two renames on the same docName in
    // quick succession) must not issue parallel sendToken calls or stack
    // racy authenticationFailed dispatches. The
    // `serverDrivenCloseReauthInFlight` guard de-duplicates within the
    // first attempt's lifetime — the integration counterpart proves the
    // post-settle path. Here we pin the in-flight coalescing only.
    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open('doc-burst');
    if (!entry) throw new Error('expected entry');
    const provider = entry.provider as {
      sendToken: () => Promise<void>;
      emit: (e: string, p: unknown) => void;
    };
    // A pending-forever promise keeps the guard latched so we can probe
    // the synchronous burst behavior without racing against microtask
    // resolution.
    const neverResolve = new Promise<void>(() => {});
    const sendTokenSpy = spyOn(provider, 'sendToken').mockReturnValue(neverResolve);
    sendTokenSpy.mockClear();
    provider.emit('close', { event: { code: 1000, reason: 'first' } });
    provider.emit('close', { event: { code: 1000, reason: 'second' } });
    provider.emit('close', { event: { code: 1000, reason: 'third' } });
    expect(sendTokenSpy).toHaveBeenCalledTimes(1);
  });

  test("'rename-redirect' / 'doc-deleted' with no handler set are clean no-ops", () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open('doc-a');
    if (!entry) throw new Error('expected entry');
    expect(() => emit(entry, 'rename-redirect:doc-b')).not.toThrow();
    expect(() => emit(entry, 'doc-deleted')).not.toThrow();
  });

  test("existing 'server-instance-mismatch' arm is unchanged by the new arms", () => {
    pool = new ProviderPool(3, DUMMY_WS);
    let renameRedirectCalls = 0;
    let docDeletedCalls = 0;
    pool.setOnRenameRedirect(() => {
      renameRedirectCalls++;
    });
    pool.setOnDocDeleted(() => {
      docDeletedCalls++;
    });
    pool.setExpectedServerInstanceId('old-instance-id');
    const entry = pool.open('doc-svr');
    if (!entry) throw new Error('expected entry');
    emit(entry, 'server-instance-mismatch');
    // Neither new arm should fire on a server-instance-mismatch.
    expect(renameRedirectCalls).toBe(0);
    expect(docDeletedCalls).toBe(0);
  });
});
