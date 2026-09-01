import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { BranchSwitchedClearFailedLogSchema, handleBranchSwitched } from './branch-invalidation';
import { ProviderPool } from './provider-pool';

const DUMMY_WS = 'ws://localhost:1/collab';

const TEST_SERVER_INSTANCE_ID = 'test-server-instance';

let pool: ProviderPool;

afterEach(() => {
  pool?.dispose();
});

function docName(prefix = 'branch-inv'): string {
  return `${prefix}-${randomUUID()}`;
}

async function awaitAttachedPersistence(entry: {
  persistence: { clearData(): Promise<void> } | null;
}): Promise<{ clearData(): Promise<void> }> {
  const deadline = Date.now() + 2_000;
  while (entry.persistence === null && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  const persistence = entry.persistence;
  if (persistence === null) throw new Error('expected persistence to attach');
  return persistence;
}

describe('handleBranchSwitched', () => {
  test("calls clearData on every entry's persistence", async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
    const d1 = docName('d1');
    const d2 = docName('d2');
    const e1 = pool.open(d1);
    const e2 = pool.open(d2);
    if (!e1 || !e2) throw new Error('pool.open returned null');
    const p1 = await awaitAttachedPersistence(e1);
    const p2 = await awaitAttachedPersistence(e2);

    const clear1 = vi.fn(() => Promise.resolve());
    const clear2 = vi.fn(() => Promise.resolve());
    p1.clearData = clear1;
    p2.clearData = clear2;

    await handleBranchSwitched(pool, 'feature');

    expect(clear1).toHaveBeenCalledTimes(1);
    expect(clear2).toHaveBeenCalledTimes(1);
  });

  test('recycles all entries after clearData resolves', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
    const d1 = docName('d1');
    const d2 = docName('d2');
    const e1 = pool.open(d1);
    const e2 = pool.open(d2);
    if (!e1 || !e2) throw new Error('pool.open returned null');
    const p1 = await awaitAttachedPersistence(e1);
    const p2 = await awaitAttachedPersistence(e2);

    let clearResolved = false;
    const clearPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        clearResolved = true;
        resolve();
      }, 20);
    });
    p1.clearData = vi.fn(() => clearPromise);
    p2.clearData = vi.fn(() => Promise.resolve());

    let recycleObservedClearResolved = false;
    const originalRecycle = pool.recycleAllEntries.bind(pool);
    pool.recycleAllEntries = vi.fn(() => {
      recycleObservedClearResolved = clearResolved;
      originalRecycle();
    });

    await handleBranchSwitched(pool, 'feature');

    expect(pool.recycleAllEntries).toHaveBeenCalledTimes(1);
    expect(recycleObservedClearResolved).toBe(true);
  });

  test('skips entries that are tearing down', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
    const d1 = docName('d1');
    const d2 = docName('d2');
    const e1 = pool.open(d1);
    const e2 = pool.open(d2);
    if (!e1 || !e2) throw new Error('pool.open returned null');
    if (e1.kind !== 'active' || e2.kind !== 'active') throw new Error('expected active');
    const p1 = await awaitAttachedPersistence(e1);
    const p2 = await awaitAttachedPersistence(e2);

    const clear1 = vi.fn(() => Promise.resolve());
    const clear2 = vi.fn(() => Promise.resolve());
    p1.clearData = clear1;
    p2.clearData = clear2;

    const torn = e1 as unknown as {
      kind: 'tearing-down';
      persistence: null;
      observerCleanup: null;
      pendingRecycleTimer: null;
    };
    torn.kind = 'tearing-down';
    torn.persistence = null;

    await handleBranchSwitched(pool, 'feature');

    expect(clear1).toHaveBeenCalledTimes(0);
    expect(clear2).toHaveBeenCalledTimes(1);
  });

  test('swallows clearData failures and still recycles', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
    const d1 = docName('d1');
    const e1 = pool.open(d1);
    if (!e1) throw new Error('pool.open returned null');
    const p1 = await awaitAttachedPersistence(e1);

    p1.clearData = vi.fn(() => Promise.reject(new Error('simulated-idb-quota-exhausted')));

    const originalRecycle = pool.recycleAllEntries.bind(pool);
    const recycleSpy = vi.fn(() => {
      originalRecycle();
    });
    pool.recycleAllEntries = recycleSpy;

    const logSpy = vi.fn((_msg: string) => {});
    const originalWarn = console.warn;
    console.warn = logSpy as unknown as typeof console.warn;
    try {
      await handleBranchSwitched(pool, 'feature');
    } finally {
      console.warn = originalWarn;
    }

    expect(recycleSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalled();
    const firstLog: string | undefined = logSpy.mock.calls[0]?.[0];
    if (firstLog === undefined) throw new Error('expected warn call');
    const parsed = BranchSwitchedClearFailedLogSchema.parse(JSON.parse(firstLog));
    expect(parsed.event).toBe('ok-branch-switched-clear-failed');
    expect(parsed.branch).toBe('feature');
  });

  test('is a no-op when the pool has no entries', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const recycleSpy = vi.fn(() => {});
    pool.recycleAllEntries = recycleSpy;

    await handleBranchSwitched(pool, 'feature');

    expect(recycleSpy).toHaveBeenCalledTimes(1);
  });

  test('drains pool.bufferedUpdates so branch-A bytes never replay onto branch B', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const d1 = docName('d1');
    const d2 = docName('d2');
    pool.open(d1);
    pool.open(d2);

    pool.__test_seedBufferedUpdate(d1, new Uint8Array([0x01, 0x02]));
    pool.__test_seedBufferedUpdate(d2, new Uint8Array([0x03, 0x04]));
    expect(pool.__test_bufferedUpdatesSize()).toBe(2);

    await handleBranchSwitched(pool, 'feature');

    expect(pool.__test_bufferedUpdatesSize()).toBe(0);
    expect(pool.__test_hasBufferedUpdate(d1)).toBe(false);
    expect(pool.__test_hasBufferedUpdate(d2)).toBe(false);
  });

  test('stands down while a server-instance-mismatch recycle owns the pool', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      pool = new ProviderPool(3, DUMMY_WS);
      pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
      pool.setObservedBranch('main');
      const d1 = docName('combined');
      const entry = pool.open(d1);
      if (!entry) throw new Error('expected entry');
      pool.setActive(d1);
      await awaitAttachedPersistence(entry);

      pool.setExpectedServerInstanceId('server-rotated');
      expect(pool.isMismatchRecycleInFlight()).toBe(true);
      await handleBranchSwitched(pool, 'feature');

      const deferred = warnSpy.mock.calls.filter(([first]) => {
        if (typeof first !== 'string') return false;
        try {
          return (
            (JSON.parse(first) as { event?: string }).event ===
            'ok-branch-switched-deferred-to-mismatch-recycle'
          );
        } catch {
          return false;
        }
      });
      expect(deferred.length).toBe(1);

      await pool.awaitMismatchSettled();

      const recycleAlls = infoSpy.mock.calls.filter(([first]) => {
        if (typeof first !== 'string') return false;
        try {
          return (JSON.parse(first) as { event?: string }).event === 'ok-pool-recycle-all';
        } catch {
          return false;
        }
      });
      expect(recycleAlls.length).toBe(1);
    } finally {
      warnSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  test('a buffer captured on another branch is discarded rather than replayed', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      pool = new ProviderPool(3, DUMMY_WS);
      pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
      pool.setObservedBranch('main');
      const d1 = docName('provenance');
      const entry = pool.open(d1);
      if (!entry) throw new Error('expected entry');
      pool.setActive(d1);
      await awaitAttachedPersistence(entry);

      entry.provider.emit('authenticationFailed', { reason: 'server-instance-mismatch' });
      await pool.awaitMismatchSettled();
      const fresh = pool.entries.get(d1);
      if (!fresh || fresh.kind !== 'active') throw new Error('expected a recycled entry');

      pool.__test_seedBufferedUpdate(d1, new Uint8Array([0x01, 0x02]), { branch: 'main' });
      pool.setObservedBranch('feature');
      fresh.provider.emit('synced', { state: true });

      const deadline = Date.now() + 2_000;
      while (pool.__test_hasBufferedUpdate(d1) && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(pool.__test_hasBufferedUpdate(d1)).toBe(false);

      const fenced = warnSpy.mock.calls.filter(([first]) => {
        if (typeof first !== 'string') return false;
        try {
          return (
            (JSON.parse(first) as { event?: string }).event === 'ok-buffer-replay-branch-mismatch'
          );
        } catch {
          return false;
        }
      });
      expect(fenced.length).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('ProviderPool.close drains bufferedUpdates', () => {
  let pool: ProviderPool;

  afterEach(() => {
    pool?.dispose();
  });

  test('close(docName) deletes the doc from bufferedUpdates', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const d1 = docName('d1');
    pool.open(d1);

    pool.__test_seedBufferedUpdate(d1, new Uint8Array([0x42]));
    expect(pool.__test_hasBufferedUpdate(d1)).toBe(true);

    pool.close(d1);

    expect(pool.__test_hasBufferedUpdate(d1)).toBe(false);
    expect(pool.__test_bufferedUpdatesSize()).toBe(0);
  });
});
