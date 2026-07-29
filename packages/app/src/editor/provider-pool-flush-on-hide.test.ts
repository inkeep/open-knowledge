/**
 * Pool-level contract for the background-flush / resync-on-visible
 * mechanism: `flushOnHide()` pushes each pending doc's work to the server
 * and commits its IDB cache; `resyncOnVisible()` re-runs the sync
 * handshake; the `bridge.flushOnHide.enabled` kill-switch makes both inert.
 *
 * `forceSync` (server round-trip) and `flushFullState` (IDB commit) are the
 * two outgoing boundary commands the mechanism issues, so they are the
 * spy targets here. The real "delta reaches the SERVER" outcome is proven
 * end-to-end against a live server in the integration tier; this suite pins
 * the pool's gating logic deterministically without wall-clock waits.
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientPersistenceProvider } from './client-persistence';
import { ProviderPool } from './provider-pool';

type OpenEntry = NonNullable<ReturnType<ProviderPool['open']>>;

function openEntry(p: ProviderPool, docName: string): OpenEntry {
  const entry = p.open(docName);
  if (entry === null) throw new Error(`expected open("${docName}") to return an entry`);
  return entry;
}

const DUMMY_WS = 'ws://localhost:1/collab';
const TEST_SERVER_INSTANCE_ID = 'flush-on-hide-epoch';

function uniqueDocName(): string {
  return `flush-hide-${randomUUID()}`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await wait(10);
  }
  return predicate();
}

async function awaitPersistence(entry: {
  persistence: ClientPersistenceProvider | null;
}): Promise<ClientPersistenceProvider> {
  await waitFor(() => entry.persistence !== null);
  if (entry.persistence === null) throw new Error('expected persistence to attach');
  return entry.persistence;
}

let pool: ProviderPool;
afterEach(() => {
  pool?.dispose();
});

describe('ProviderPool background flush-on-hide', () => {
  it('force-syncs the server AND commits IDB for a doc with a pending delta', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
    const docName = uniqueDocName();
    const entry = openEntry(pool, docName);
    pool.setActive(docName);
    const persistence = await awaitPersistence(entry);

    // A local WYSIWYG-shaped edit bumps unsyncedChanges (the "pending delta"
    // precondition) — the provider is never connected on DUMMY_WS, so the
    // edit stays unacked.
    entry.provider.document.getText('source').insert(0, 'pending edit');
    expect(entry.provider.unsyncedChanges).toBeGreaterThan(0);

    const forceSyncSpy = vi.spyOn(entry.provider, 'forceSync').mockImplementation(() => {});
    const flushSpy = vi.spyOn(persistence, 'flushFullState').mockResolvedValue(undefined);

    pool.flushOnHide();

    expect(forceSyncSpy).toHaveBeenCalledTimes(1);
    expect(flushSpy).toHaveBeenCalledTimes(1);
  });

  it('is inert when the kill-switch is off (no force-sync, no IDB commit)', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
    const docName = uniqueDocName();
    const entry = openEntry(pool, docName);
    pool.setActive(docName);
    const persistence = await awaitPersistence(entry);
    entry.provider.document.getText('source').insert(0, 'pending edit');
    expect(entry.provider.unsyncedChanges).toBeGreaterThan(0);

    const forceSyncSpy = vi.spyOn(entry.provider, 'forceSync').mockImplementation(() => {});
    const flushSpy = vi.spyOn(persistence, 'flushFullState').mockResolvedValue(undefined);

    pool.setFlushOnHideEnabled(false);
    pool.flushOnHide();

    expect(forceSyncSpy).not.toHaveBeenCalled();
    expect(flushSpy).not.toHaveBeenCalled();
  });

  it('skips docs with no pending delta', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const docName = uniqueDocName();
    const entry = openEntry(pool, docName);
    pool.setActive(docName);
    // No edit — unsyncedChanges stays 0.
    expect(entry.provider.unsyncedChanges).toBe(0);

    const forceSyncSpy = vi.spyOn(entry.provider, 'forceSync').mockImplementation(() => {});
    pool.flushOnHide();

    expect(forceSyncSpy).not.toHaveBeenCalled();
  });

  it('resyncOnVisible re-runs the sync handshake for active docs', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const docName = uniqueDocName();
    const entry = openEntry(pool, docName);
    pool.setActive(docName);
    entry.provider.emit('synced', { state: true });
    // resync pulls server-side changes the tab may have missed while hidden,
    // so it fires regardless of local pending state.
    const forceSyncSpy = vi.spyOn(entry.provider, 'forceSync').mockImplementation(() => {});

    pool.resyncOnVisible();

    expect(forceSyncSpy).toHaveBeenCalledTimes(1);
  });

  it('resyncOnVisible skips a disconnected doc rather than latching it dirty', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const docName = uniqueDocName();
    const entry = openEntry(pool, docName);
    pool.setActive(docName);
    entry.provider.emit('synced', { state: true });
    entry.provider.emit('status', { status: 'disconnected' });

    // Precondition: the doc is CLEAN. The real `forceSync()` runs
    // `resetUnsyncedChanges()`, which sets unsyncedChanges to 1 unconditionally
    // and only returns to 0 when the server answers — so calling it here would
    // pin a clean doc dirty for the whole disconnect. Un-mocked on purpose:
    // the latch is the behavior under test, not the call.
    expect(entry.provider.unsyncedChanges).toBe(0);

    pool.resyncOnVisible();

    expect(entry.provider.unsyncedChanges).toBe(0);
    expect(pool.hasAnyUnsyncedWork()).toBe(false);
  });

  it('resyncOnVisible is inert when the kill-switch is off', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const docName = uniqueDocName();
    const entry = openEntry(pool, docName);
    pool.setActive(docName);
    entry.provider.emit('synced', { state: true });
    const forceSyncSpy = vi.spyOn(entry.provider, 'forceSync').mockImplementation(() => {});

    pool.setFlushOnHideEnabled(false);
    pool.resyncOnVisible();

    expect(forceSyncSpy).not.toHaveBeenCalled();
  });

  it('emits a structured recovery event when the unload IDB flush rejects (never silent)', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
    const docName = uniqueDocName();
    const entry = openEntry(pool, docName);
    pool.setActive(docName);
    const persistence = await awaitPersistence(entry);
    entry.provider.document.getText('source').insert(0, 'pending edit');
    expect(entry.provider.unsyncedChanges).toBeGreaterThan(0);

    vi.spyOn(entry.provider, 'forceSync').mockImplementation(() => {});
    // The unload path's effective durability is this IDB commit; a rejection
    // here (quota, aborted tx) loses edits, so it must be observable — not
    // swallowed by an empty catch.
    vi.spyOn(persistence, 'flushFullState').mockRejectedValue(
      new Error('flushFullState transaction aborted'),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    pool.flushOnHide();
    await waitFor(() =>
      warnSpy.mock.calls.some((c) => String(c[0]).includes('ok-pool-flush-on-hide-failed')),
    );
    const emitted = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes('ok-pool-flush-on-hide-failed'));
    warnSpy.mockRestore();

    expect(emitted).toBeDefined();
    // Content-free breadcrumb: names the doc + error name, never document content.
    expect(emitted).toContain(docName);
    expect(emitted).toContain('flushFullState transaction aborted');
  });

  it('flushOnHide stands down while a mismatch recycle is in flight', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
    const docName = uniqueDocName();
    const entry = openEntry(pool, docName);
    pool.setActive(docName);
    const persistence = await awaitPersistence(entry);
    entry.provider.document.getText('source').insert(0, 'pending edit');

    const forceSyncSpy = vi.spyOn(entry.provider, 'forceSync').mockImplementation(() => {});
    const flushSpy = vi.spyOn(persistence, 'flushFullState').mockResolvedValue(undefined);

    // Planted positive: this doc IS flush-eligible right now, so a later
    // "not called" can only come from the recycle guard.
    pool.flushOnHide();
    expect(forceSyncSpy).toHaveBeenCalledTimes(1);
    forceSyncSpy.mockClear();
    flushSpy.mockClear();

    // Open the recycle window. The mismatch flow captures this delta into the
    // durable outbox and owns re-delivery; a concurrent forceSync would race
    // the very epoch being recycled away.
    entry.provider.emit('authenticationFailed', { reason: 'server-instance-mismatch' });

    pool.flushOnHide();

    expect(forceSyncSpy).not.toHaveBeenCalled();
    expect(flushSpy).not.toHaveBeenCalled();

    await pool.awaitMismatchSettled();
  });

  it('a throwing unsynced-work listener does not stop the next one or escape the provider event', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
    const docName = uniqueDocName();
    const entry = openEntry(pool, docName);
    pool.setActive(docName);
    await awaitPersistence(entry);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let reachedSecond = 0;
    // Insertion order is iteration order, so the thrower runs first.
    const offA = pool.addUnsyncedWorkListener(() => {
      throw new Error('ipc boom');
    });
    const offB = pool.addUnsyncedWorkListener(() => {
      reachedSecond += 1;
    });

    try {
      // Driven the way production drives it: a provider unsynced-work edge.
      expect(() => entry.provider.emit('unsyncedChanges', { number: 1 })).not.toThrow();
      expect(reachedSecond).toBe(1);
      // Reported, not swallowed.
      expect(
        warn.mock.calls.some(([arg]) =>
          String(arg).includes('ok-pool-unsynced-work-listener-threw'),
        ),
      ).toBe(true);
    } finally {
      offA();
      offB();
      warn.mockRestore();
    }
  });

  it('resyncOnVisible stands down while a mismatch recycle is in flight', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
    const docName = uniqueDocName();
    const entry = openEntry(pool, docName);
    pool.setActive(docName);
    await awaitPersistence(entry);
    entry.provider.emit('synced', { state: true });

    const forceSyncSpy = vi.spyOn(entry.provider, 'forceSync').mockImplementation(() => {});

    // Planted positive: this doc IS resync-eligible right now, so a later
    // "not called" can only come from the recycle guard.
    pool.resyncOnVisible();
    expect(forceSyncSpy).toHaveBeenCalledTimes(1);
    forceSyncSpy.mockClear();

    // Open the recycle window. Re-syncing here races the epoch being recycled
    // away and latches unsyncedChanges on a provider about to be destroyed.
    entry.provider.emit('authenticationFailed', { reason: 'server-instance-mismatch' });

    pool.resyncOnVisible();

    expect(forceSyncSpy).not.toHaveBeenCalled();

    await pool.awaitMismatchSettled();
  });
});
