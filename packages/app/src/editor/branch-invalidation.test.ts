import { afterEach, describe, expect, mock, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { BranchSwitchedClearFailedLogSchema, handleBranchSwitched } from './branch-invalidation';
import { ProviderPool } from './provider-pool';

// Pool ingests real HocuspocusProvider instances pointing at an unreachable
// URL. Providers stall in 'connecting'; no WebSocket round-trip occurs. This
// is the same pattern `provider-pool.test.ts` uses for mechanism-only checks
// — we care about clearData / recycleAllEntries dispatch, not wire behavior.
const DUMMY_WS = 'ws://localhost:1/collab';

// Persistence attaches only after a serverInstanceId is known
// (epoch-scoped IDB DB names). Tests that mock `entry.persistence.*`
// must seed the live epoch before `pool.open()` so the pool actually
// constructs an `IndexeddbPersistence`.
const TEST_SERVER_INSTANCE_ID = 'test-server-instance';

let pool: ProviderPool;

afterEach(() => {
  pool?.dispose();
});

function docName(prefix = 'branch-inv'): string {
  return `${prefix}-${randomUUID()}`;
}

// Record-absent opens attach persistence through the asynchronous
// stored-state validation spine, so tests that mock `entry.persistence.*`
// first await the attach. The end states they assert are unchanged.
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

    const clear1 = mock(() => Promise.resolve());
    const clear2 = mock(() => Promise.resolve());
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

    // Causal-ordering check (not wall-clock): set a flag inside the
    // clearData resolver, assert it inside the recycle wrapper. Proves
    // recycle ran AFTER clearData's microtask without depending on
    // Date.now() resolution.
    let clearResolved = false;
    const clearPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        clearResolved = true;
        resolve();
      }, 20);
    });
    p1.clearData = mock(() => clearPromise);
    p2.clearData = mock(() => Promise.resolve());

    let recycleObservedClearResolved = false;
    const originalRecycle = pool.recycleAllEntries.bind(pool);
    pool.recycleAllEntries = mock(() => {
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

    const clear1 = mock(() => Promise.resolve());
    const clear2 = mock(() => Promise.resolve());
    p1.clearData = clear1;
    p2.clearData = clear2;

    // Flip e1 to tearing-down (matches the variant `destroyEntry` produces).
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

  // The case "active entry with null persistence (mid-teardown)"
  // is structurally impossible: the discriminated union enforces that
  // `persistence === null` only on `kind: 'tearing-down'` variants. The
  // tearing-down skip is covered above. The runtime null-persistence
  // guard has been replaced by a static type invariant.

  test('swallows clearData failures and still recycles', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    pool.setExpectedServerInstanceId(TEST_SERVER_INSTANCE_ID);
    const d1 = docName('d1');
    const e1 = pool.open(d1);
    if (!e1) throw new Error('pool.open returned null');
    const p1 = await awaitAttachedPersistence(e1);

    p1.clearData = mock(() => Promise.reject(new Error('simulated-idb-quota-exhausted')));

    const originalRecycle = pool.recycleAllEntries.bind(pool);
    const recycleSpy = mock(() => {
      originalRecycle();
    });
    pool.recycleAllEntries = recycleSpy;

    const logSpy = mock((_msg: string) => {});
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
    const recycleSpy = mock(() => {});
    pool.recycleAllEntries = recycleSpy;

    await handleBranchSwitched(pool, 'feature');

    expect(recycleSpy).toHaveBeenCalledTimes(1);
  });

  // Cross-branch buffer-leak regression: a `server-instance-mismatch`
  // recycle populates `pool.bufferedUpdates` for every entry with
  // unsynced changes — including non-active docs whose buffer wouldn't
  // drain on the next active-doc sync. Without `clearBufferedUpdates()`
  // in handleBranchSwitched, those branch-A buffers replay onto the new
  // branch B Y.Doc when the user later opens the non-active doc. This
  // test makes that regression loud.
  test('drains pool.bufferedUpdates so branch-A bytes never replay onto branch B', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    // Bind docNames once and reuse — `docName(prefix)` returns a fresh
    // UUID on every call, so re-invoking it inline produces unrelated
    // keys that defeat per-doc assertions (lookups would always return
    // false regardless of whether the buffer was actually drained).
    const d1 = docName('d1');
    const d2 = docName('d2');
    pool.open(d1);
    pool.open(d2);

    // Seed buffers as if a `server-instance-mismatch` recycle just
    // populated them with unsynced edits captured against branch A.
    pool.__test_seedBufferedUpdate(d1, new Uint8Array([0x01, 0x02]));
    pool.__test_seedBufferedUpdate(d2, new Uint8Array([0x03, 0x04]));
    expect(pool.__test_bufferedUpdatesSize()).toBe(2);

    await handleBranchSwitched(pool, 'feature');

    // Buffers must be empty after branch switch — branch-A edits are
    // semantically invalid against branch B's content.
    expect(pool.__test_bufferedUpdatesSize()).toBe(0);
    expect(pool.__test_hasBufferedUpdate(d1)).toBe(false);
    expect(pool.__test_hasBufferedUpdate(d2)).toBe(false);
  });
});

describe('ProviderPool.close drains bufferedUpdates', () => {
  let pool: ProviderPool;

  afterEach(() => {
    pool?.dispose();
  });

  // Companion to the cross-branch buffer-drain test above. An explicit
  // user close (tab close, programmatic close) should discard the
  // pending replay buffer for that doc — resurrecting unsynced edits
  // later (when the user re-opens the doc) would surprise them.
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
