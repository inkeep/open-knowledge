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
    await writeReplayOutboxEntry(
      { branch: 'main', docName: 'doc-a', namespace: null },
      {
        delta: bytes(1, 2, 3),
        fullState: bytes(9, 8, 7, 6),
      },
    );
    const read = await readReplayOutboxEntry({ branch: 'main', docName: 'doc-a', namespace: null });
    expect(read).not.toBeNull();
    expect(Array.from(read?.delta ?? [])).toEqual([1, 2, 3]);
    expect(Array.from(read?.fullState ?? [])).toEqual([9, 8, 7, 6]);
  });

  it('returns null and creates no database when no outbox exists', async () => {
    const read = await readReplayOutboxEntry({
      branch: 'main',
      docName: 'never-written',
      namespace: null,
    });
    expect(read).toBeNull();
    // A normal doc open must not litter an empty outbox database.
    expect(await hasOutboxDb('ok-replay-outbox:main:never-written')).toBe(false);
  });

  it('a consumed entry reads back as null', async () => {
    await writeReplayOutboxEntry(
      { branch: 'main', docName: 'doc-b', namespace: null },
      { delta: bytes(1), fullState: bytes(2) },
    );
    await consumeReplayOutboxEntry({ branch: 'main', docName: 'doc-b', namespace: null });
    expect(
      await readReplayOutboxEntry({ branch: 'main', docName: 'doc-b', namespace: null }),
    ).toBeNull();
  });

  it('consume reports whether IT removed a live record', async () => {
    await writeReplayOutboxEntry(
      { branch: 'main', docName: 'doc-claim', namespace: null },
      { delta: bytes(1), fullState: bytes(2) },
    );
    // The claim: first consumer takes the record, every later consumer of the
    // same record is told it lost.
    expect(
      await consumeReplayOutboxEntry({ branch: 'main', docName: 'doc-claim', namespace: null }),
    ).toBe(true);
    expect(
      await consumeReplayOutboxEntry({ branch: 'main', docName: 'doc-claim', namespace: null }),
    ).toBe(false);
    // Never written at all reads the same as already-claimed.
    expect(
      await consumeReplayOutboxEntry({
        branch: 'main',
        docName: 'doc-claim-absent',
        namespace: null,
      }),
    ).toBe(false);
  });

  it('concurrent consumers of one record: exactly one claims it', async () => {
    await writeReplayOutboxEntry(
      { branch: 'main', docName: 'doc-race', namespace: null },
      { delta: bytes(7), fullState: bytes(8) },
    );

    // Two tabs of one project racing the same `(namespace, branch, docName)`
    // token. The count+delete pair runs inside ONE readwrite transaction, and
    // IndexedDB serializes overlapping readwrite transactions across
    // connections, so this is an atomic compare-and-claim rather than a
    // check-then-act that both callers could win.
    const results = await Promise.all([
      consumeReplayOutboxEntry({ branch: 'main', docName: 'doc-race', namespace: null }),
      consumeReplayOutboxEntry({ branch: 'main', docName: 'doc-race', namespace: null }),
      consumeReplayOutboxEntry({ branch: 'main', docName: 'doc-race', namespace: null }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      await readReplayOutboxEntry({ branch: 'main', docName: 'doc-race', namespace: null }),
    ).toBeNull();
  });

  it('a later write overwrites an existing entry', async () => {
    await writeReplayOutboxEntry(
      { branch: 'main', docName: 'doc-c', namespace: null },
      { delta: bytes(1), fullState: bytes(1) },
    );
    await writeReplayOutboxEntry(
      { branch: 'main', docName: 'doc-c', namespace: null },
      { delta: bytes(5, 5), fullState: bytes(6, 6) },
    );
    const read = await readReplayOutboxEntry({ branch: 'main', docName: 'doc-c', namespace: null });
    expect(Array.from(read?.delta ?? [])).toEqual([5, 5]);
    expect(Array.from(read?.fullState ?? [])).toEqual([6, 6]);
  });

  it('scopes entries by branch and docName', async () => {
    await writeReplayOutboxEntry(
      { branch: 'main', docName: 'shared', namespace: null },
      { delta: bytes(1), fullState: bytes(1) },
    );
    expect(
      await readReplayOutboxEntry({ branch: 'feature', docName: 'shared', namespace: null }),
    ).toBeNull();
    expect(
      await readReplayOutboxEntry({ branch: 'main', docName: 'other', namespace: null }),
    ).toBeNull();
    expect(
      await readReplayOutboxEntry({ branch: 'main', docName: 'shared', namespace: null }),
    ).not.toBeNull();
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
    expect(
      await readReplayOutboxEntry({ branch: 'main', docName: 'garbage', namespace: null }),
    ).toBeNull();
  });

  it('consuming an absent outbox is a no-op', async () => {
    await expect(
      consumeReplayOutboxEntry({ branch: 'main', docName: 'absent', namespace: null }),
    ).resolves.toBe(false);
    expect(await hasOutboxDb('ok-replay-outbox:main:absent')).toBe(false);
  });

  it('writes nothing on an engine with no indexedDB.databases()', async () => {
    // Without `databases()` the read path can never probe for this record, so
    // a write would strand a full doc-state payload in storage that nothing
    // can consume or reclaim. The write must decline and SAY it declined, so
    // the caller knows its buffer is RAM-only.
    await withoutDatabasesApi(async () => {
      const persisted = await writeReplayOutboxEntry(
        { branch: 'main', docName: 'no-databases-api', namespace: null },
        {
          delta: bytes(1, 2, 3),
          fullState: bytes(4, 5, 6),
        },
      );
      expect(persisted).toBe(false);
    });

    expect(await hasOutboxDb('ok-replay-outbox:main:no-databases-api')).toBe(false);
    expect(
      await readReplayOutboxEntry({ branch: 'main', docName: 'no-databases-api', namespace: null }),
    ).toBeNull();
  });

  it('rejects with a timeout rather than hanging when IndexedDB stalls', async () => {
    // The recycle awaits the write BEFORE clearData(), so an operation that
    // never settles strands the whole recovery: the IDB is never cleared, the
    // providers are never recycled, the in-flight marker never clears, and
    // flush-on-hide stays inert behind it. A stalled storage layer has to
    // surface as a bounded failure.
    vi.useFakeTimers();
    vi.spyOn(indexedDB, 'databases').mockReturnValue(new Promise(() => {}));

    const stalled = consumeReplayOutboxEntry({
      branch: 'main',
      docName: 'doc-stalled',
      namespace: null,
    });
    const assertion = expect(stalled).rejects.toBeInstanceOf(ReplayOutboxTimeoutError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it('reports a committed write so the caller can trust the durable copy', async () => {
    const persisted = await writeReplayOutboxEntry(
      { branch: 'main', docName: 'doc-persisted', namespace: null },
      {
        delta: bytes(1),
        fullState: bytes(2),
      },
    );
    expect(persisted).toBe(true);
    expect(
      await readReplayOutboxEntry({ branch: 'main', docName: 'doc-persisted', namespace: null }),
    ).not.toBeNull();
  });

  it('commits the write transaction explicitly and still stores the entry', async () => {
    // The whole point of this write is to be durable before `clearData()`
    // runs, and a tab can die before the idle turn that would auto-commit it.
    // The write path is the only one here that calls commit() explicitly, so a
    // call on the prototype during it is attributable to that path.
    const commitSpy = vi.spyOn(IDBTransaction.prototype, 'commit');
    try {
      const persisted = await writeReplayOutboxEntry(
        { branch: 'main', docName: 'doc-explicit-commit', namespace: null },
        {
          delta: bytes(7),
          fullState: bytes(8),
        },
      );
      expect(persisted).toBe(true);
      expect(commitSpy).toHaveBeenCalled();
    } finally {
      commitSpy.mockRestore();
    }

    // Committing early must not cost durability: the entry is readable back.
    const entry = await readReplayOutboxEntry({
      branch: 'main',
      docName: 'doc-explicit-commit',
      namespace: null,
    });
    expect(entry).not.toBeNull();
    expect(Array.from(entry?.delta ?? [])).toEqual([7]);
    expect(Array.from(entry?.fullState ?? [])).toEqual([8]);
  });
});

/**
 * The outbox database name must carry a project component.
 *
 * `docName` is repo-root-relative and branch names repeat, so two worktrees of
 * one repository checked out on the same branch address the same doc path.
 * Every packaged project window loads the renderer through `loadFile`, so they
 * also share one `file://` origin — same-origin means same-app, not
 * same-project. Without a project component those two windows share one outbox
 * database, and the payload is buffered document content: a collision crosses
 * edits between projects instead of raising an error.
 */
describe('replay-outbox project scoping', () => {
  const PROJECT_A = '/Users/dev/repo/.worktrees/a';
  const PROJECT_B = '/Users/dev/repo/.worktrees/b';

  it('isolates two projects sharing one branch and docName', async () => {
    await writeReplayOutboxEntry(
      { branch: 'main', docName: 'notes/todo.md', namespace: PROJECT_A },
      { delta: bytes(1), fullState: bytes(0xaa) },
    );
    await writeReplayOutboxEntry(
      { branch: 'main', docName: 'notes/todo.md', namespace: PROJECT_B },
      { delta: bytes(2), fullState: bytes(0xbb) },
    );

    // Each project reads back its OWN bytes. Unscoped, B's write lands on A's
    // record and both reads return 0xbb.
    const fromA = await readReplayOutboxEntry({
      branch: 'main',
      docName: 'notes/todo.md',
      namespace: PROJECT_A,
    });
    const fromB = await readReplayOutboxEntry({
      branch: 'main',
      docName: 'notes/todo.md',
      namespace: PROJECT_B,
    });
    expect(Array.from(fromA?.fullState ?? [])).toEqual([0xaa]);
    expect(Array.from(fromB?.fullState ?? [])).toEqual([0xbb]);
  });

  it("consuming one project's record leaves the sibling project's intact", async () => {
    await writeReplayOutboxEntry(
      { branch: 'main', docName: 'notes/todo.md', namespace: PROJECT_A },
      { delta: bytes(1), fullState: bytes(0xaa) },
    );
    await writeReplayOutboxEntry(
      { branch: 'main', docName: 'notes/todo.md', namespace: PROJECT_B },
      { delta: bytes(2), fullState: bytes(0xbb) },
    );

    // The cross-tab exactly-once claim is per PROJECT, not per app. A window
    // in project A replaying its edit must not stand down a window in
    // project B, whose edit is a different document entirely.
    expect(
      await consumeReplayOutboxEntry({
        branch: 'main',
        docName: 'notes/todo.md',
        namespace: PROJECT_A,
      }),
    ).toBe(true);
    expect(
      await consumeReplayOutboxEntry({
        branch: 'main',
        docName: 'notes/todo.md',
        namespace: PROJECT_B,
      }),
    ).toBe(true);
  });

  it('keeps the cross-tab claim shared between tabs of the SAME project', async () => {
    await writeReplayOutboxEntry(
      { branch: 'main', docName: 'notes/todo.md', namespace: PROJECT_A },
      { delta: bytes(1), fullState: bytes(0xaa) },
    );
    // Two tabs of one project still contend for one record: the second must
    // lose the claim, or the edit replays twice.
    expect(
      await consumeReplayOutboxEntry({
        branch: 'main',
        docName: 'notes/todo.md',
        namespace: PROJECT_A,
      }),
    ).toBe(true);
    expect(
      await consumeReplayOutboxEntry({
        branch: 'main',
        docName: 'notes/todo.md',
        namespace: PROJECT_A,
      }),
    ).toBe(false);
  });

  it('leaves the database name unchanged when there is no project namespace', async () => {
    // Web hosts are served per project on `http://127.0.0.1:<port>`, so the
    // origin already isolates them and the bare name stays correct. Holding
    // the name steady there also means no existing record is orphaned.
    await writeReplayOutboxEntry(
      { branch: 'main', docName: 'doc-unscoped', namespace: null },
      { delta: bytes(1), fullState: bytes(2) },
    );
    expect(await hasOutboxDb('ok-replay-outbox:main:doc-unscoped')).toBe(true);
  });
});
