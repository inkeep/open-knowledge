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

    pool.flushOnHide();
    expect(forceSyncSpy).toHaveBeenCalledTimes(1);
    forceSyncSpy.mockClear();
    flushSpy.mockClear();

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
    const offA = pool.addUnsyncedWorkListener(() => {
      throw new Error('ipc boom');
    });
    const offB = pool.addUnsyncedWorkListener(() => {
      reachedSecond += 1;
    });

    try {
      expect(() => entry.provider.emit('unsyncedChanges', { number: 1 })).not.toThrow();
      expect(reachedSecond).toBe(1);
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

    pool.resyncOnVisible();
    expect(forceSyncSpy).toHaveBeenCalledTimes(1);
    forceSyncSpy.mockClear();

    entry.provider.emit('authenticationFailed', { reason: 'server-instance-mismatch' });

    pool.resyncOnVisible();

    expect(forceSyncSpy).not.toHaveBeenCalled();

    await pool.awaitMismatchSettled();
  });
});
