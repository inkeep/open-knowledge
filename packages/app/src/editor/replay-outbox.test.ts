/**
 * Unit tests for the durable replay outbox — the IndexedDB store that carries
 * an unsynced edit across a tab crash in the `server-instance-mismatch`
 * recycle window. Runs against the globally-installed `fake-indexeddb`
 * (idb-preload setup file), which wipes all databases after each test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  consumeReplayOutboxEntry,
  ReplayOutboxTimeoutError,
  readReplayOutboxEntry,
  writeReplayOutboxEntry,
} from './replay-outbox';

function bytes(...vals: number[]): Uint8Array {
  return new Uint8Array(vals);
}

async function hasOutboxDb(dbName: string): Promise<boolean> {
  const dbs = await indexedDB.databases();
  return dbs.some((d) => d.name === dbName);
}

/**
 * Run `body` against an engine that has no `indexedDB.databases()` (Firefox
 * < 126 / Safari < 14). Shadowing the prototype method on the instance is
 * what the module's own capability probe reads.
 */
async function withoutDatabasesApi(body: () => Promise<void>): Promise<void> {
  const factory = indexedDB as unknown as { databases?: unknown };
  factory.databases = undefined;
  try {
    await body();
  } finally {
    delete factory.databases;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('replay-outbox', () => {
  it('round-trips a written entry byte-for-byte', async () => {
    await writeReplayOutboxEntry('main', 'doc-a', {
      delta: bytes(1, 2, 3),
      fullState: bytes(9, 8, 7, 6),
    });
    const read = await readReplayOutboxEntry('main', 'doc-a');
    expect(read).not.toBeNull();
    expect(Array.from(read?.delta ?? [])).toEqual([1, 2, 3]);
    expect(Array.from(read?.fullState ?? [])).toEqual([9, 8, 7, 6]);
  });

  it('returns null and creates no database when no outbox exists', async () => {
    const read = await readReplayOutboxEntry('main', 'never-written');
    expect(read).toBeNull();
    // A normal doc open must not litter an empty outbox database.
    expect(await hasOutboxDb('ok-replay-outbox:main:never-written')).toBe(false);
  });

  it('a consumed entry reads back as null', async () => {
    await writeReplayOutboxEntry('main', 'doc-b', { delta: bytes(1), fullState: bytes(2) });
    await consumeReplayOutboxEntry('main', 'doc-b');
    expect(await readReplayOutboxEntry('main', 'doc-b')).toBeNull();
  });

  it('consume reports whether IT removed a live record', async () => {
    await writeReplayOutboxEntry('main', 'doc-claim', { delta: bytes(1), fullState: bytes(2) });
    // The claim: first consumer takes the record, every later consumer of the
    // same record is told it lost.
    expect(await consumeReplayOutboxEntry('main', 'doc-claim')).toBe(true);
    expect(await consumeReplayOutboxEntry('main', 'doc-claim')).toBe(false);
    // Never written at all reads the same as already-claimed.
    expect(await consumeReplayOutboxEntry('main', 'doc-claim-absent')).toBe(false);
  });

  it('concurrent consumers of one record: exactly one claims it', async () => {
    await writeReplayOutboxEntry('main', 'doc-race', { delta: bytes(7), fullState: bytes(8) });

    // Two same-origin tabs racing the same `(branch, docName)` token. The
    // count+delete pair runs inside ONE readwrite transaction, and IndexedDB
    // serializes overlapping readwrite transactions across connections, so
    // this is an atomic compare-and-claim rather than a check-then-act that
    // both callers could win.
    const results = await Promise.all([
      consumeReplayOutboxEntry('main', 'doc-race'),
      consumeReplayOutboxEntry('main', 'doc-race'),
      consumeReplayOutboxEntry('main', 'doc-race'),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await readReplayOutboxEntry('main', 'doc-race')).toBeNull();
  });

  it('a later write overwrites an existing entry', async () => {
    await writeReplayOutboxEntry('main', 'doc-c', { delta: bytes(1), fullState: bytes(1) });
    await writeReplayOutboxEntry('main', 'doc-c', { delta: bytes(5, 5), fullState: bytes(6, 6) });
    const read = await readReplayOutboxEntry('main', 'doc-c');
    expect(Array.from(read?.delta ?? [])).toEqual([5, 5]);
    expect(Array.from(read?.fullState ?? [])).toEqual([6, 6]);
  });

  it('scopes entries by branch and docName', async () => {
    await writeReplayOutboxEntry('main', 'shared', { delta: bytes(1), fullState: bytes(1) });
    expect(await readReplayOutboxEntry('feature', 'shared')).toBeNull();
    expect(await readReplayOutboxEntry('main', 'other')).toBeNull();
    expect(await readReplayOutboxEntry('main', 'shared')).not.toBeNull();
  });

  it('reads null for a foreign/truncated record rather than returning garbage', async () => {
    // Plant a record whose shape is not {delta, fullState} Uint8Arrays,
    // directly against the outbox DB's store shape (a truncated write or a
    // record from a future schema must read as "nothing to replay").
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('ok-replay-outbox:main:garbage');
      req.onupgradeneeded = () => req.result.createObjectStore('entry');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('entry', 'readwrite');
        tx.objectStore('entry').put({ delta: 'not-bytes', fullState: 42 }, 'buffer');
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
    expect(await readReplayOutboxEntry('main', 'garbage')).toBeNull();
  });

  it('consuming an absent outbox is a no-op', async () => {
    await expect(consumeReplayOutboxEntry('main', 'absent')).resolves.toBe(false);
    expect(await hasOutboxDb('ok-replay-outbox:main:absent')).toBe(false);
  });

  it('writes nothing on an engine with no indexedDB.databases()', async () => {
    // Without `databases()` the read path can never probe for this record, so
    // a write would strand a full doc-state payload in storage that nothing
    // can consume or reclaim. The write must decline and SAY it declined, so
    // the caller knows its buffer is RAM-only.
    await withoutDatabasesApi(async () => {
      const persisted = await writeReplayOutboxEntry('main', 'no-databases-api', {
        delta: bytes(1, 2, 3),
        fullState: bytes(4, 5, 6),
      });
      expect(persisted).toBe(false);
    });

    expect(await hasOutboxDb('ok-replay-outbox:main:no-databases-api')).toBe(false);
    expect(await readReplayOutboxEntry('main', 'no-databases-api')).toBeNull();
  });

  it('rejects with a timeout rather than hanging when IndexedDB stalls', async () => {
    // The recycle awaits the write BEFORE clearData(), so an operation that
    // never settles strands the whole recovery: the IDB is never cleared, the
    // providers are never recycled, the in-flight marker never clears, and
    // flush-on-hide stays inert behind it. A stalled storage layer has to
    // surface as a bounded failure.
    vi.useFakeTimers();
    vi.spyOn(indexedDB, 'databases').mockReturnValue(new Promise(() => {}));

    const stalled = consumeReplayOutboxEntry('main', 'doc-stalled');
    const assertion = expect(stalled).rejects.toBeInstanceOf(ReplayOutboxTimeoutError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it('reports a committed write so the caller can trust the durable copy', async () => {
    const persisted = await writeReplayOutboxEntry('main', 'doc-persisted', {
      delta: bytes(1),
      fullState: bytes(2),
    });
    expect(persisted).toBe(true);
    expect(await readReplayOutboxEntry('main', 'doc-persisted')).not.toBeNull();
  });

  it('commits the write transaction explicitly and still stores the entry', async () => {
    // The whole point of this write is to be durable before `clearData()`
    // runs, and a tab can die before the idle turn that would auto-commit it.
    // The write path is the only one here that calls commit() explicitly, so a
    // call on the prototype during it is attributable to that path.
    const commitSpy = vi.spyOn(IDBTransaction.prototype, 'commit');
    try {
      const persisted = await writeReplayOutboxEntry('main', 'doc-explicit-commit', {
        delta: bytes(7),
        fullState: bytes(8),
      });
      expect(persisted).toBe(true);
      expect(commitSpy).toHaveBeenCalled();
    } finally {
      commitSpy.mockRestore();
    }

    // Committing early must not cost durability: the entry is readable back.
    const entry = await readReplayOutboxEntry('main', 'doc-explicit-commit');
    expect(entry).not.toBeNull();
    expect(Array.from(entry?.delta ?? [])).toEqual([7]);
    expect(Array.from(entry?.fullState ?? [])).toEqual([8]);
  });
});
