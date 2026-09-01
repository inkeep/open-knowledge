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

const REPLAY_OUTBOX_TIMEOUT_MS = 5_000;

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

function isReplayOutboxSupported(): boolean {
  return typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function';
}

export interface ReplayOutboxEntry {
  readonly delta: Uint8Array;
  readonly fullState: Uint8Array;
}

export interface ReplayOutboxKey {
  readonly branch: string;
  readonly docName: string;
  readonly namespace: string | null;
}

function outboxDbName({ branch, docName, namespace }: ReplayOutboxKey): string {
  return `${scopedStorageKey(REPLAY_OUTBOX_DB_PREFIX, namespace)}:${branch}:${docName}`;
}

function openOutboxDb(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
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

async function outboxDbExists(dbName: string): Promise<boolean> {
  if (!isReplayOutboxSupported()) return false;
  const dbs = await indexedDB.databases();
  return dbs.some((d) => d.name === dbName);
}

export async function writeReplayOutboxEntry(
  key: ReplayOutboxKey,
  entry: ReplayOutboxEntry,
): Promise<boolean> {
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
          if (typeof tx.commit === 'function') tx.commit();
        });
        return true;
      } finally {
        db.close();
      }
    })(),
  );
}

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
