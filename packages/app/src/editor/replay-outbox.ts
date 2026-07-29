/**
 * Durable, epoch-agnostic replay outbox for the `server-instance-mismatch`
 * recycle.
 *
 * The provider pool's in-memory `bufferedUpdates` map loses its content if the
 * tab dies inside the recycle window (`clearData()` → recycle → first
 * `synced`). This outbox is the durable carrier: the unsynced edit's full
 * pre-recycle state is written here BEFORE `clearData()` wipes the y-indexeddb
 * store, and read back on the next open of the doc — surviving a tab crash at
 * any point up to the replay.
 *
 * It is a SEPARATE IndexedDB database (`ok-replay-outbox:<branch>:<docName>`),
 * NEVER the y-indexeddb `updates` store: hydrating the pre-recycle bytes back
 * into the fresh Y.Doc is exactly the content-duplication class `clearData`
 * exists to prevent. The reopen path reads this store explicitly and feeds the
 * bytes through the CONTENT-level replay (rebuild a replica, splice the
 * recovered string) rather than a Y.Doc merge.
 *
 * The db name is branch+docName scoped (not epoch-scoped): the post-recycle
 * `serverInstanceId` is unknown when the buffer is captured (the client nulls
 * its cached id and only relearns it from the reconnect handshake), so the
 * epoch cannot be part of the key. Branch isolation mirrors the y-indexeddb
 * naming.
 *
 * Durable recovery requires `indexedDB.databases()` (Baseline). On engines
 * without it EVERY operation no-ops (degrade to RAM-only): the read/consume
 * because they cannot probe for existence without `open` creating an empty
 * database on a normal doc open, and the WRITE because a record no reader can
 * ever see is a full doc-state payload stranded in storage forever. The write
 * reports that with a `false` return so the caller knows the buffer is
 * RAM-only.
 *
 * The single `(branch, docName)` record is also the CROSS-TAB exactly-once
 * token: same-origin tabs share it, so `consumeReplayOutboxEntry` reports
 * whether THIS caller was the one that removed a live record. Its count+delete
 * run in one `readwrite` transaction, and IndexedDB serializes overlapping
 * readwrite transactions across connections, which makes the pair an atomic
 * compare-and-claim rather than a check-then-act.
 *
 * Consumed entries leave an empty outbox database behind (record deleted, DB
 * kept) rather than racing a `deleteDatabase` against a concurrent reopen —
 * a bounded, per-docName storage-hygiene cost matching the `_unknown_`-branch
 * orphan note in `client-persistence.ts`.
 *
 * Every operation is deadline-bounded. The recycle path awaits the write
 * BEFORE `clearData()`, so an IDB stall that never settles would strand the
 * whole recovery (no clear, no recycle, `mismatchInFlight` pinned, flush-on-
 * hide inert) — the same hazard `withClearDataTimeout` already bounds on the
 * sibling clear. Note the bound is NOT an `onblocked` substitute: these opens
 * are versionless, so they never request a version change and can never fire
 * `blocked` (only `deleteDatabase` and an upgrading open can). The deadline
 * covers the general stall, not a version-change block.
 */

const REPLAY_OUTBOX_DB_PREFIX = 'ok-replay-outbox';
const ENTRY_STORE_NAME = 'entry';
const ENTRY_KEY = 'buffer';

/**
 * Deadline for one outbox operation (open + transaction). Generous relative to
 * a local IDB round-trip: this bounds a pathological stall, it is not a
 * latency budget.
 */
const REPLAY_OUTBOX_TIMEOUT_MS = 5_000;

/**
 * Thrown when an outbox operation misses {@link REPLAY_OUTBOX_TIMEOUT_MS}.
 *
 * Exported so the recycle path can tell a STALL from an IDB error — the same
 * `failureKind: 'timeout' | 'rejected'` split `ClientPersistenceClearTimeoutError`
 * drives on the sibling clear. They call for different operator responses: an
 * error is a failed operation, a timeout means the storage layer is wedged and
 * the recovery it was gating is stuck behind it.
 */
export class ReplayOutboxTimeoutError extends Error {
  constructor(operation: string, docName: string) {
    super(`[replay-outbox] ${operation} timed out after ${REPLAY_OUTBOX_TIMEOUT_MS}ms: ${docName}`);
    this.name = 'ReplayOutboxTimeoutError';
  }
}

function withOutboxTimeout<T>(operation: string, docName: string, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ReplayOutboxTimeoutError(operation, docName));
    }, REPLAY_OUTBOX_TIMEOUT_MS);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Whether this engine can carry a durable replay buffer at all. `databases()`
 * is the gate for every operation, not just the reads — see the module note.
 */
function isReplayOutboxSupported(): boolean {
  return typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function';
}

/**
 * Persisted shape of one doc's unsynced-edit buffer. Mirrors the in-memory
 * `bufferedUpdates` value, except `fullState` is always present: the outbox is
 * only written when content-level replay is possible (over-cap docs, whose
 * `fullState` is dropped, stay RAM-only).
 */
export interface ReplayOutboxEntry {
  readonly delta: Uint8Array;
  readonly fullState: Uint8Array;
}

function outboxDbName(branch: string, docName: string): string {
  return `${REPLAY_OUTBOX_DB_PREFIX}:${branch}:${docName}`;
}

function openOutboxDb(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // Versionless open so the store-creation upgrade only runs when the DB is
    // first created — matching y-indexeddb's own attach pattern.
    const req = indexedDB.open(dbName);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ENTRY_STORE_NAME)) {
        db.createObjectStore(ENTRY_STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Whether an outbox DB already exists, WITHOUT creating one. `indexedDB.open`
 * would create+upgrade a missing DB, littering an empty outbox on every normal
 * doc open; gating reads/consumes on this keeps that from happening. Engines
 * without `indexedDB.databases()` (pre-Baseline) report "absent" so durable
 * recovery degrades to RAM-only rather than pollute storage.
 *
 * `databases()` enumerates ALL origin databases and runs on the first `synced`
 * of a doc open (via `readReplayOutboxEntry`), so its cost scales with the
 * origin's total database count, not just outbox DBs. The consumed-but-kept
 * empty outboxes (see the module note) add to that count only per recycled
 * `(branch, docName)` — a bounded subset dwarfed by the per-epoch y-indexeddb
 * stores this call already lists — so retaining them is a storage-hygiene cost,
 * not an enumeration-cost regression that would justify racing a `deleteDatabase`
 * against a concurrent reopen.
 */
async function outboxDbExists(dbName: string): Promise<boolean> {
  if (!isReplayOutboxSupported()) return false;
  const dbs = await indexedDB.databases();
  return dbs.some((d) => d.name === dbName);
}

/**
 * Persist one doc's unsynced-edit buffer. Called during the mismatch recycle,
 * BEFORE `clearData()`, so a crash while the y-indexeddb store is being wiped
 * still leaves the buffer recoverable.
 *
 * Resolves `true` when the record committed and a later reopen can read it
 * back, `false` when this engine cannot carry a durable buffer at all. The
 * caller uses that to decide whether a durable copy backs its RAM buffer.
 */
export async function writeReplayOutboxEntry(
  branch: string,
  docName: string,
  entry: ReplayOutboxEntry,
): Promise<boolean> {
  // No `databases()` means no reader will ever find this record: writing it
  // would strand a full doc-state payload in storage with nothing able to
  // consume or reclaim it. Report RAM-only instead.
  if (!isReplayOutboxSupported()) return false;
  const dbName = outboxDbName(branch, docName);
  return withOutboxTimeout(
    'write',
    docName,
    (async () => {
      const db = await openOutboxDb(dbName);
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(ENTRY_STORE_NAME, 'readwrite');
          tx.objectStore(ENTRY_STORE_NAME).put(
            { delta: entry.delta, fullState: entry.fullState },
            ENTRY_KEY,
          );
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error ?? new Error('replay-outbox write aborted'));
          // Explicitly commit rather than waiting for the auto-commit that
          // fires when the event loop next has no pending requests. This write
          // exists to survive a tab death in the recycle window, and that death
          // can land before the idle turn arrives, so starting the commit now
          // shortens the window it has to survive. Handlers are attached first
          // so none can be missed. Guarded — not every engine implements the
          // (Baseline) method. Matches the flush path in client-persistence.ts.
          if (typeof tx.commit === 'function') tx.commit();
        });
        return true;
      } finally {
        db.close();
      }
    })(),
  );
}

/**
 * Read a doc's persisted buffer, or null when none exists (normal open, or a
 * consumed outbox). Never creates a DB for a doc that has no outbox.
 */
export async function readReplayOutboxEntry(
  branch: string,
  docName: string,
): Promise<ReplayOutboxEntry | null> {
  if (!isReplayOutboxSupported()) return null;
  const dbName = outboxDbName(branch, docName);
  return withOutboxTimeout(
    'read',
    docName,
    (async () => {
      if (!(await outboxDbExists(dbName))) return null;
      const db = await openOutboxDb(dbName);
      try {
        const value = await new Promise<unknown>((resolve, reject) => {
          const tx = db.transaction(ENTRY_STORE_NAME, 'readonly');
          const get = tx.objectStore(ENTRY_STORE_NAME).get(ENTRY_KEY);
          get.onsuccess = () => resolve(get.result);
          get.onerror = () => reject(get.error);
        });
        if (value === undefined || value === null) return null;
        const record = value as { delta?: unknown; fullState?: unknown };
        // A truncated/foreign record must read as "nothing to replay" rather
        // than feed garbage bytes into the Y.Doc apply.
        if (!(record.delta instanceof Uint8Array) || !(record.fullState instanceof Uint8Array)) {
          return null;
        }
        return { delta: record.delta, fullState: record.fullState };
      } finally {
        db.close();
      }
    })(),
  );
}

/**
 * Consume a doc's buffer by deleting its record, and report whether THIS
 * caller was the one that removed a live record.
 *
 * That boolean is the cross-tab exactly-once claim. Same-origin tabs share one
 * `(branch, docName)` record, so a `false` return means another tab already
 * consumed it and owns the replay — re-applying on top would not be idempotent
 * (see `replayBufferedContent`'s surface attribution). The count and the delete
 * run in ONE `readwrite` transaction and IndexedDB serializes overlapping
 * readwrite transactions across connections, so the pair is an atomic
 * compare-and-claim, not a check-then-act.
 *
 * Idempotent for callers that only want the record gone (consuming an absent
 * record resolves `false` rather than throwing).
 */
export async function consumeReplayOutboxEntry(branch: string, docName: string): Promise<boolean> {
  if (!isReplayOutboxSupported()) return false;
  const dbName = outboxDbName(branch, docName);
  return withOutboxTimeout(
    'consume',
    docName,
    (async () => {
      if (!(await outboxDbExists(dbName))) return false;
      const db = await openOutboxDb(dbName);
      try {
        return await new Promise<boolean>((resolve, reject) => {
          const tx = db.transaction(ENTRY_STORE_NAME, 'readwrite');
          const store = tx.objectStore(ENTRY_STORE_NAME);
          let claimed = false;
          const count = store.count(ENTRY_KEY);
          count.onsuccess = () => {
            claimed = count.result > 0;
          };
          store.delete(ENTRY_KEY);
          tx.oncomplete = () => resolve(claimed);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error ?? new Error('replay-outbox consume aborted'));
        });
      } finally {
        db.close();
      }
    })(),
  );
}
