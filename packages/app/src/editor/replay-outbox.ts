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
 * It is a SEPARATE IndexedDB database
 * (`ok-replay-outbox[:<project digest>]:<branch>:<docName>` — the project
 * segment is absent on a null namespace), NEVER the y-indexeddb
 * `updates` store: hydrating the pre-recycle bytes back into the fresh Y.Doc
 * is exactly the content-duplication class `clearData` exists to prevent. The
 * reopen path reads this store explicitly and feeds the bytes through the
 * CONTENT-level replay (rebuild a replica, splice the recovered string) rather
 * than a Y.Doc merge.
 *
 * The db name is project+branch+docName scoped (not epoch-scoped): the
 * post-recycle `serverInstanceId` is unknown when the buffer is captured (the
 * client nulls its cached id and only relearns it from the reconnect
 * handshake), so the epoch cannot be part of the key.
 *
 * The project component is REQUIRED for every desktop window, and omitted
 * only for a null namespace, where the origin already isolates — that is
 * `precedent #59`, applied here through `scopedStorageKey`
 * (`lib/storage-scope.ts`), not re-derived. What is specific to THIS
 * store: `docName` is repo-root-relative and branch names repeat, so two
 * worktrees of one repository on the same branch address the same doc path,
 * and the payload here is buffered document content — so a collision crosses
 * edits between projects rather than raising an error. The sibling
 * y-indexeddb store in `client-persistence.ts` is safe without a project
 * component only because its name carries the per-process `serverInstanceId`,
 * which this one cannot have; the omission of the epoch does not license
 * omitting project identity.
 *
 * `namespace` is threaded in from the caller rather than resolved in here, and
 * travels in a NAMED field (`ReplayOutboxKey`) rather than a positional slot.
 * Requiredness only forces a value to be supplied; naming is what stops a
 * wrong one — three bare strings in a row compile in any order.
 *
 * A namespace change renames the database, so an entry written under a
 * different one is not read back. That has three causes, all accepted:
 *
 * 1. The one-time upgrade from the pre-scoping name. Deliberately NOT
 *    migrated: adopting an unscoped record would import the cross-project
 *    content this scoping removes, which is the bug. Electron only, since a
 *    null namespace reproduces the old name exactly. The stranded set is
 *    every LIVE pre-scoping record, not just one caught mid-recycle. Every
 *    consume path runs INSIDE a live session: a reopen's replay, or an
 *    intentional discard through `discardBufferedUpdate` (see its docblock for
 *    the full trigger set). The RAM buffer's `durable` flag
 *    gates every one of those EXCEPT the reopen that finds no RAM buffer at
 *    all — the tab-died case this outbox exists for, which reads the record
 *    directly and claims it unconditionally. Ordinary app termination — quit,
 *    force-quit, `quitAndInstall` — runs none of them. So a doc not reopened
 *    between its write and the upgrade keeps an unreachable record. Stranding
 *    is also silent: a null read is indistinguishable from "nothing to
 *    recover".
 * 2. Ongoing: the namespace is the project path AS THE USER PICKED IT, not
 *    its realpath (`window-manager.ts` keeps `projectPath` and `canonicalKey`
 *    deliberately distinct, and the renderer is handed the former). So
 *    reopening one project under a different spelling of the same path
 *    (`/tmp` vs `/private/tmp`, a symlinked cwd, Windows drive-letter case)
 *    reads a different name and misses its own parked edit.
 * 3. A revert of this change orphans records written under the NEW name, for
 *    the same reason as (1) — the desktop updater rolls forward only, so a
 *    rollback ships as a revert.
 *
 * Case 2 costs a missed recovery on a best-effort mechanism; the collision it
 * replaces silently applied ANOTHER project's content. Canonicalizing is
 * additive rather than blocked — `window-manager.ts` already computes
 * `canonicalKey`, and identity reaches the renderer as independently-parsed
 * spawn args — but it touches the desktop spawn surface and every
 * editor-window path, so it is deferred rather than bundled here.
 *
 * Durable recovery requires `indexedDB.databases()` (Baseline). On engines
 * without it EVERY operation no-ops (degrade to RAM-only): the read/consume
 * because they cannot probe for existence without `open` creating an empty
 * database on a normal doc open, and the WRITE because a record no reader can
 * ever see is a full doc-state payload stranded in storage forever. The write
 * reports that with a `false` return so the caller knows the buffer is
 * RAM-only.
 *
 * The single `(namespace, branch, docName)` record is also the CROSS-TAB
 * exactly-once token: tabs resolving the same namespace share it, so
 * `consumeReplayOutboxEntry` reports whether THIS caller was the one that
 * removed a live record. Its count+delete run in one `readwrite` transaction,
 * and IndexedDB serializes overlapping readwrite transactions across
 * connections, which makes the pair an atomic compare-and-claim rather than a
 * check-then-act.
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

import { scopedStorageKey } from '@/lib/storage-scope';

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

/**
 * Addresses ONE outbox record. Object-literal form for the reason
 * `CreateClientPersistenceArgs` in `client-persistence.ts` gives for the
 * sibling IDB name: the fields are indistinguishable to the type system, so
 * positionally a swap compiles cleanly and silently produces the wrong
 * database name — here defeating the cross-project defense.
 */
export interface ReplayOutboxKey {
  readonly branch: string;
  readonly docName: string;
  /** See the module header. `null` only on hosts the origin already isolates. */
  readonly namespace: string | null;
}

/**
 * `<prefix>[:<project digest>]:<branch>:<docName>`. The project segment is
 * ABSENT for a null namespace, which is what keeps the web-host name
 * byte-identical to its pre-scoping form.
 *
 * The project component is what keeps two windows of DIFFERENT projects off
 * one database — see the `namespace` note in the module header. It is applied
 * by `scopedStorageKey` to the PREFIX rather than appended to the whole name,
 * so no web-host record is orphaned by this change.
 */
function outboxDbName({ branch, docName, namespace }: ReplayOutboxKey): string {
  return `${scopedStorageKey(REPLAY_OUTBOX_DB_PREFIX, namespace)}:${branch}:${docName}`;
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
 * empty outboxes (see the module note) add to that count per recycled
 * `(namespace, branch, docName)`, so it scales with projects opened as well as
 * docs recycled — N worktrees sharing a branch and a doc path leave N orphans
 * where they once left one. Still dwarfed by the per-epoch y-indexeddb stores
 * this call already lists, so retaining them remains a storage-hygiene cost
 * rather than an enumeration-cost regression that would justify racing a
 * `deleteDatabase` against a concurrent reopen — but the project multiplier is
 * the term to re-check if that ever stops holding.
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
  key: ReplayOutboxKey,
  entry: ReplayOutboxEntry,
): Promise<boolean> {
  // No `databases()` means no reader will ever find this record: writing it
  // would strand a full doc-state payload in storage with nothing able to
  // consume or reclaim it. Report RAM-only instead.
  if (!isReplayOutboxSupported()) return false;
  const { docName } = key;
  const dbName = outboxDbName(key);
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
  key: ReplayOutboxKey,
): Promise<ReplayOutboxEntry | null> {
  if (!isReplayOutboxSupported()) return null;
  const { docName } = key;
  const dbName = outboxDbName(key);
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
 * That boolean is the cross-tab exactly-once claim. Tabs resolving the SAME
 * namespace share one `(namespace, branch, docName)` record, so a `false`
 * return USUALLY means another such tab consumed it and owns the replay —
 * re-applying on top would not be idempotent (see `replayBufferedContent`'s
 * surface attribution). Not always: this claims the KEY, not the record, so a
 * stale detached consume from an earlier discard can also take it, in which
 * case no tab owns the edit. `discardBufferedUpdate`'s docblock has that race
 * and why it is accepted. Standing down is right either way — this caller
 * cannot tell the cases apart, and applying against a real winner does not
 * duplicate the edit, it REVERTS it: once the winner's content is on the
 * server the surface attribution inverts, so the splice puts this tab's stale
 * pre-recycle bytes back over the recovery.
 *
 * The count and the delete run in ONE `readwrite` transaction and IndexedDB
 * serializes overlapping readwrite transactions across connections, so the
 * pair is an atomic compare-and-claim, not a check-then-act.
 *
 * A window of a DIFFERENT project must never lose this claim: its buffered
 * edit belongs to a different document that merely shares a path and a branch
 * name. That is what the project component guarantees.
 *
 * Idempotent for callers that only want the record gone (consuming an absent
 * record resolves `false` rather than throwing).
 */
export async function consumeReplayOutboxEntry(key: ReplayOutboxKey): Promise<boolean> {
  if (!isReplayOutboxSupported()) return false;
  const { docName } = key;
  const dbName = outboxDbName(key);
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
