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

async function awaitAttachedPersistence(entry: {
  persistence: ClientPersistenceProvider | null;
}): Promise<ClientPersistenceProvider> {
  await waitFor(() => entry.persistence !== null, 2_000);
  const persistence = entry.persistence;
  if (persistence === null) throw new Error('expected persistence to attach');
  return persistence;
}

const DUMMY_WS = 'ws://localhost:1/collab';

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
    await wait(2);
    const second = pool.open(docName);
    expect(second).toBe(fresh); // identity preserved
    expect(second?.poolEventId).toBe(stableId);
    expect((second?.lastAccessedAt ?? 0) >= previousAccessedAt).toBe(true);
    const c = getCollector();
    const counter = c?.counters['ok/pool/open'];
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
    expect(c?.marks.length).toBe(beforeMarks);
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
    pool.open('doc1');
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
    pool.setActive('doc1');
    pool.open('doc4');
    expect(pool.has('doc1')).toBe(true);
    expect(pool.has('doc2')).toBe(false);
  });

  test('eviction with capacity 1 and active doc', () => {
    pool = new ProviderPool(1, DUMMY_WS);
    pool.open('doc1');
    pool.setActive('doc1');
    pool.open('doc2');
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
    pool = new ProviderPool(3, DUMMY_WS, { recycleDebounceMs: 50 });
    const entry = pool.open('doc1');
    if (!entry) throw new Error('expected entry');
    pool.setActive('doc1');

    const originalProvider = entry.provider;
    originalProvider.emit('synced', { state: true });
    originalProvider.emit('disconnect', {
      event: { code: 1006, reason: 'server restart', wasClean: false },
    });

    expect(entry.pendingRecycleTimer).not.toBeNull();

    await wait(100);

    const recycled = pool.getActive();
    expect(recycled).not.toBeNull();
    expect(recycled?.provider).not.toBe(originalProvider);
    expect(recycled?.docName).toBe('doc1');
  });

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

  test('init-time throw rejects held syncPromise with BridgeSetupError + leaves entry pool-resident', async () => {
    pool = new ProviderPool(3, DUMMY_WS);

    const entry = pool.open('doc1');
    if (!entry) throw new Error('expected entry');
    pool.setActive('doc1');

    const consumerPromise = syncPromise('doc1', entry.provider);

    const doc = entry.provider.document;
    doc.getXmlFragment = () => {
      throw new Error('synthetic getXmlFragment failure');
    };

    const errorSpy = mock(() => {});
    const origError = console.error;
    console.error = errorSpy;

    entry.provider.emit('synced', { state: true });

    console.error = origError;

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

    expect(pool.has('doc1')).toBe(true);
    expect(pool.entries.get('doc1')?.bridgeSetupFailed).toBe(true);
    expect(pool.getActiveDocName()).toBe('doc1');
    expect(pool.getActive()?.provider).toBe(entry.provider);

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

    pool.recycle('doc1');

    expect(pool.has('doc1')).toBe(true);
    expect(pool.getActiveDocName()).toBe('doc1');
    const newEntry = pool.entries.get('doc1');
    expect(newEntry).toBeDefined();
    expect(newEntry?.provider).not.toBe(brokenProvider);
    expect(newEntry?.bridgeSetupFailed).toBe(false);
  });

  test('non-active background doc disconnect triggers debounced destroy without re-open', async () => {
    pool = new ProviderPool(3, DUMMY_WS, { recycleDebounceMs: 50 });
    let onChangeCalls = 0;
    pool.setOnChange(() => onChangeCalls++);

    const entry1 = pool.open('doc1');
    if (!entry1) throw new Error('expected entry1');
    pool.setActive('doc1');
    const entry2 = pool.open('doc2');
    if (!entry2) throw new Error('expected entry2');
    onChangeCalls = 0;

    entry2.provider.emit('synced', { state: true });
    entry2.provider.unsyncedChanges = 0;

    entry2.provider.emit('disconnect', {
      event: { code: 1006, reason: 'server restart', wasClean: false },
    });

    expect(entry2.pendingRecycleTimer).not.toBeNull();
    expect(pool.has('doc2')).toBe(true);

    await wait(100);

    expect(pool.has('doc2')).toBe(false);

    expect(pool.has('doc1')).toBe(true);
    expect(pool.getActiveDocName()).toBe('doc1');
    expect(pool.getActive()?.provider).toBe(entry1.provider);

    expect(pool.entries.size).toBe(1);

    expect(onChangeCalls).toBeGreaterThanOrEqual(1);
  });

  test('recycle debounce is cancelled when provider reconnects (onSynced)', () => {
    pool = new ProviderPool(3, DUMMY_WS, { recycleDebounceMs: 200 });
    const entry = pool.open('doc1');
    if (!entry) throw new Error('expected entry');
    pool.setActive('doc1');

    entry.observerCleanup = () => {};

    entry.hasSynced = true;
    entry.syncState = 'synced';
    entry.provider.unsyncedChanges = 0;

    entry.provider.emit('disconnect', {
      event: { code: 1006, reason: 'server restart', wasClean: false },
    });
    expect(entry.pendingRecycleTimer).not.toBeNull();
    const _originalTimer = entry.pendingRecycleTimer;

    entry.provider.emit('synced', { state: true });
    expect(entry.pendingRecycleTimer).toBeNull();

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
    pool.open('user-a');
    pool.open('user-b');
    pool.setActive('user-b'); // Pin active to prevent eviction

    pool.prewarm('prewarm-c');
    expect(pool.has('prewarm-c')).toBe(true);

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
    expect(entry.provider.configuration.forceSyncInterval).toBe(5000);
  });
});

describe('buildAuthToken (MECHANISM-ONLY — CRDT restart recovery + client version)', () => {
  test('always returns a token carrying client version metadata, even anonymous', () => {
    const token = buildAuthToken(null, null);
    const parsed = parseHocuspocusAuthToken(token);
    if (!parsed) throw new Error('expected valid token');
    expect(parsed.clientProtocolVersion).toBe(PROTOCOL_VERSION);
    expect(typeof parsed.clientRuntimeVersion).toBe('string');
    expect(parsed.clientKind).toBe('web');
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
    (entry.provider as unknown as { emit: (e: string, p: unknown) => void }).emit(
      'authenticationFailed',
      { reason: 'branch-mismatch' },
    );
    await Promise.resolve();
    expect(called).toBe(1);
  });

  test('branch-mismatch with no handler set is a clean no-op', () => {
    pool = new ProviderPool(3, DUMMY_WS);
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
    await Promise.resolve();

    expect(called).toBe(1);

    if (pending !== null) (pending as () => void)();
    await wait(0);
    emit(e1);
    await Promise.resolve();
    expect(called).toBe(2);
  });

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
    await Promise.resolve();
    await Promise.resolve();
    emit(e2); // cross-turn second dispatch
    await Promise.resolve();
    expect(called).toBe(1);
    if (resolveWork !== null) (resolveWork as () => void)();
    await wait(0);
  });

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
      const entry = pool.open('doc1');
      if (!entry) throw new Error('expected entry');
      const parsed = parseHocuspocusAuthToken(entry.provider.configuration.token as string);
      if (!parsed) throw new Error('expected valid token');
      expect(parsed.expectedBranch).toBe('feature');
    });
  });

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

    const entry1 = pool.open('doc1');
    if (!entry1) throw new Error('expected entry1');

    pool.setExpectedServerInstanceId('server-instance-xyz');

    const entry2 = pool.open('doc2');
    if (!entry2) throw new Error('expected entry2');

    const tok1 = parseHocuspocusAuthToken(entry1.provider.configuration.token as string);
    const tok2 = parseHocuspocusAuthToken(entry2.provider.configuration.token as string);
    if (!tok1 || !tok2) throw new Error('expected valid tokens');
    expect(tok1.expectedServerInstanceId).toBeUndefined();
    expect(tok2.expectedServerInstanceId).toBe('server-instance-xyz');
  });
});

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

    const warnSpy = mock(() => {});
    const origWarn = console.warn;
    console.warn = warnSpy;
    entry.provider.emit('authenticationFailed', { reason: 'doc-lineage-mismatch' });
    console.warn = origWarn;

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

    await wait(10);
  });

  test('deferred-attach guard replaces a stale-lineage entry instead of hydrating it', async () => {
    const { stub } = makeStubStorage();
    pool = new ProviderPool(3, DUMMY_WS, {
      storage: stub,
      persistenceFactory: mock(makePersistenceStub),
    });
    const docName = uniqueDocName('pp-lineage-deferred');

    const first = pool.open(docName);
    if (!first) throw new Error('expected first entry');
    first.provider.document.getMap('lifecycle').set('epoch', 'epoch-dead');
    first.provider.emit('synced', { state: true });
    pool.close(docName);

    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    expect(entry.persistence).toBeNull();
    entry.provider.document.getMap('lifecycle').set('epoch', 'epoch-live');
    entry.provider.emit('synced', { state: true });

    const warnSpy = mock(() => {});
    const origWarn = console.warn;
    console.warn = warnSpy;
    pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
    console.warn = origWarn;

    const reopened = pool.peek(docName);
    if (!reopened) throw new Error('expected reopened entry');
    expect(reopened).not.toBe(entry);
    expect(tokenOf(reopened).expectedDocLineageEpoch).toBe('epoch-live');
    expect(reopened.lineageEpochRecordAtOpen).toBe('epoch-live');

    const emitted = warnSpy.mock.calls
      .map((call) => call[0] as string)
      .filter((line) => typeof line === 'string' && line.includes('ok-doc-lineage-mismatch'));
    expect(emitted.length).toBe(1);
    const event = JSON.parse(emitted[0] ?? '{}') as Record<string, string>;
    expect(event.via).toBe('deferred-attach');
    expect(event.staleEpoch).toBe('epoch-dead');
    expect(event.liveEpoch).toBe('epoch-live');

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

    await wait(50);
    expect(entry.persistence).toBeNull();

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
      expect(entry.persistence).not.toBeNull();
    } finally {
      warns.restore();
    }
  });
});

describe("ProviderPool authenticationFailed handling (US-002 / 'server-instance-mismatch')", () => {

  test("reason 'server-instance-mismatch' recycles every pool entry", async () => {
    pool = new ProviderPool(3, DUMMY_WS, { storage: null });
    pool.setExpectedServerInstanceId('server-old');

    const e1 = pool.open('doc1');
    const e2 = pool.open('doc2');
    const e3 = pool.open('doc3');
    if (!e1 || !e2 || !e3) throw new Error('expected entries');
    pool.setActive('doc1');
    const originalProvider = e1.provider;

    e1.provider.emit('authenticationFailed', { reason: 'server-instance-mismatch' });
    await pool.awaitMismatchSettled();

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
    const p = syncPromise('doc1', entry.provider);
    p.catch(() => {}); // swallow any pool-teardown rejection
    expect(__syncPromiseCacheSize()).toBe(1);

    pool.close('doc1');

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

    const e3 = pool.open('doc3');
    if (!e3) throw new Error('expected e3');

    expect(pool.has('doc2')).toBe(false);
    expect(__syncPromiseCacheSize()).toBe(1);
  });

  test('recycle after disconnect invalidates the cached syncPromise', async () => {
    pool = new ProviderPool(3, DUMMY_WS, { recycleDebounceMs: 50 });
    const entry = pool.open('doc1');
    if (!entry) throw new Error('expected entry');
    pool.setActive('doc1');
    entry.observerCleanup = () => {};

    entry.hasSynced = true;
    entry.syncState = 'synced';
    entry.provider.unsyncedChanges = 0;

    syncPromise('doc1', entry.provider).catch(() => {});
    expect(__syncPromiseCacheSize()).toBe(1);

    entry.provider.emit('disconnect', {
      event: { code: 1006, reason: 'server restart', wasClean: false },
    });

    await wait(100);

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

    entry.provider.emit('close', {
      event: { code: 1006, reason: 'network drop', wasClean: false },
    });

    await expect(p).rejects.toBeInstanceOf(PreSyncDisconnectError);
    expect(__syncPromiseCacheSize()).toBe(1);
  });
});

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
    const docName = uniqueDocName('pp-rename-noepoch');

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
    expect(dbs.find((d) => d.name === dbName)).toBeDefined();

    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(dbName);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  });

  test('rename round-trip (A→B→A) clears IDB so reopen at A starts fresh', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setObservedBranch('main');
    pool.setExpectedServerInstanceId('server-roundtrip');
    const nameA = uniqueDocName('pp-roundtrip-A');
    const nameB = uniqueDocName('pp-roundtrip-B');
    const dbA = `ok-ydoc:main:server-roundtrip:${nameA}`;
    const dbB = `ok-ydoc:main:server-roundtrip:${nameB}`;

    const entryA1 = pool.open(nameA);
    if (!entryA1) throw new Error('expected entry');
    await (await awaitAttachedPersistence(entryA1)).whenSynced;
    let dbs = await indexedDB.databases();
    expect(dbs.find((d) => d.name === dbA)).toBeDefined();

    await pool.closeAndClearPersistence(nameA);
    await pool.closeAndClearPersistence(nameB);
    dbs = await indexedDB.databases();
    expect(dbs.find((d) => d.name === dbA)).toBeUndefined();
    expect(dbs.find((d) => d.name === dbB)).toBeUndefined();

    const entryB = pool.open(nameB);
    if (!entryB) throw new Error('expected entry');
    await (await awaitAttachedPersistence(entryB)).whenSynced;
    dbs = await indexedDB.databases();
    expect(dbs.find((d) => d.name === dbB)).toBeDefined();

    await pool.closeAndClearPersistence(nameB);
    await pool.closeAndClearPersistence(nameA);
    dbs = await indexedDB.databases();
    expect(dbs.find((d) => d.name === dbA)).toBeUndefined();
    expect(dbs.find((d) => d.name === dbB)).toBeUndefined();

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

    e1.provider.emit('authenticationFailed', { reason: 'server-instance-mismatch' });
    await wait(50);

    expect(clearSpy1).toHaveBeenCalledTimes(1);
    expect(clearSpy2).toHaveBeenCalledTimes(1);
    expect(pool.has(doc2)).toBe(false);
    expect(pool.has(doc1)).toBe(true);
  });

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
    e1.observerCleanup = () => {};
    e2.observerCleanup = () => {};
    e3.observerCleanup = () => {};

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

    expect(clearOk1).toHaveBeenCalledTimes(1);
    expect(clearFail).toHaveBeenCalledTimes(1);
    expect(clearOk2).toHaveBeenCalledTimes(1);

    const post1 = pool.entries.get(doc1);
    if (!post1 || post1.kind !== 'active') throw new Error('expected active doc1 post-recycle');
    expect(post1.provider).not.toBe(preProvider1);

    expect(pool.has(doc3)).toBe(false);

    const post2 = pool.entries.get(doc2);
    if (!post2 || post2.kind !== 'active') throw new Error('expected active doc2 still in pool');
    expect(post2.provider).toBe(preProvider2);
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

      expect(clearSpy).toHaveBeenCalledTimes(1);
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

      pool = new ProviderPool(3, DUMMY_WS, { persistenceFactory, clearDataTimeoutMs: 30_000 });
      pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
      const docName = uniqueDocName('pp-pending-clears-defer-success');

      const entry1 = pool.open(docName);
      if (!entry1) throw new Error('expected entry1');
      await awaitAttachedPersistence(entry1);

      const clearPromise = pool.closeAndClearPersistence(docName);

      const entry2 = pool.open(docName);
      if (!entry2) throw new Error('expected entry2');
      expect(entry2.persistence).toBeNull();

      resolveClear();
      await clearPromise;
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

      expect(persistenceFactory).toHaveBeenCalledTimes(1);
      expect(entry2.persistence).toBeNull();
    });

    test('Promise.all batch over closeAndClearPersistence resolves even when one inner clearData rejects', async () => {
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
        expect(ok1.clearSpy).toHaveBeenCalledTimes(1);
        expect(fail.clearSpy).toHaveBeenCalledTimes(1);
        expect(ok2.clearSpy).toHaveBeenCalledTimes(1);
      } finally {
        warnSpy.mockRestore();
      }
    });

    test('non-concurrent reopen after a failed clear retries the IDB clear before attaching fresh persistence', async () => {
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

        await pool.closeAndClearPersistence(docName);
        await wait(0);

        const entry2 = pool.open(docName);
        if (!entry2) throw new Error('expected entry2');

        expect(entry2.persistence).toBeNull();

        const retryDbName = `ok-ydoc:main:${TEST_SERVER_INSTANCE_ID}:${docName}`;
        expect(deleteDbSpy.mock.calls.length).toBeGreaterThan(baselineDeleteCalls);
        expect(deleteDbSpy.mock.calls.some((call) => call[0] === retryDbName)).toBe(true);

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

describe('ProviderPool buffer-and-replay (US-004)', () => {
  test('captures the last server-synced state vector on every synced event', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open(uniqueDocName('pp-sv'));
    if (!entry) throw new Error('expected entry');
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

    pool.observeDiskAck(docName, svAfterAB);
    pool.observeDiskAck(docName, svAfterA);
    expect(entry.lastDiskAckedSV).toEqual(svAfterAB);
  });

  test('no-op when entry does not exist for docName', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    expect(() => {
      pool.observeDiskAck('nonexistent-doc', new Uint8Array([1, 2, 3]));
    }).not.toThrow();
  });

  test('no-op when entry has been removed from the pool', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const docName = uniqueDocName('pp-dack');
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    const initialSV = new Uint8Array([0xab]);
    pool.observeDiskAck(docName, initialSV);

    pool.close(docName);
    pool.observeDiskAck(docName, new Uint8Array([0xcd]));
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

    pool.observeDiskAck(docA, newerSV);
    pool.observeDiskAckBatch({ [docA]: olderSV });
    expect(entryA.lastDiskAckedSV).toEqual(newerSV);
  });
});

describe('ProviderPool handleServerInstanceMismatch baseline-selection', () => {

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

      const Y = await import('yjs');
      const cp = await import('./client-persistence');
      entry.provider.document.getText('source').insert(0, 'AAA');
      const svAfterAAA = cp.captureStateVector(entry.provider.document);
      entry.provider.document.getText('source').insert(3, 'BBB');
      const svAfterAAABBB = cp.captureStateVector(entry.provider.document);
      entry.provider.document.getText('source').insert(6, 'CCC');

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

      const expected = Y.encodeStateAsUpdate(entry.provider.document, svAfterAAA);
      expect(buffered).toEqual(expected);

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
    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open('doc-close');
    if (!entry) throw new Error('expected entry');
    const provider = entry.provider as {
      sendToken: () => Promise<void>;
      emit: (e: string, p: unknown) => void;
    };
    const sendTokenSpy = spyOn(provider, 'sendToken').mockResolvedValue();
    sendTokenSpy.mockClear();
    provider.emit('close', { event: { code: 1000, reason: 'Server closed the connection' } });
    expect(sendTokenSpy).toHaveBeenCalledTimes(1);
  });

  test("server-driven 'close' followed by sendToken rejection emits a structured warn", async () => {
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
    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open('doc-burst');
    if (!entry) throw new Error('expected entry');
    const provider = entry.provider as {
      sendToken: () => Promise<void>;
      emit: (e: string, p: unknown) => void;
    };
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
    expect(renameRedirectCalls).toBe(0);
    expect(docDeletedCalls).toBe(0);
  });
});
