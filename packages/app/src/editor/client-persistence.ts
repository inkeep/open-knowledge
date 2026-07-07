/**
 * Client-side Yjs persistence primitive.
 *
 * Wraps upstream `y-indexeddb` in a narrow, typed surface the
 * ProviderPool uses to:
 *   1. Hydrate a Y.Doc from browser IndexedDB on cold mount (instant
 *      Cmd-R).
 *   2. Wipe the IndexedDB copy on `server-instance-mismatch` so a
 *      restart doesn't mix pre- and post-restart CRDT items.
 *   3. Compute the client's unsynced delta (relative to the last
 *      server-acked state vector) so the ProviderPool can replay it
 *      onto the fresh provider after mismatch-recycle.
 *
 * IDB database names follow the canonical Yjs-ecosystem pattern of
 * "DB-per-tenant, named synchronously" (AFFiNE, tldraw, Liveblocks).
 * Format: `ok-ydoc:${branch}:${serverInstanceId}:${docName}` — branch
 * is the tenant key, `serverInstanceId` scopes the cache to the live
 * server epoch, and `docName` is the resource within. Different
 * branches → different IDBs by construction; different server epochs
 * → different IDBs by construction, so stale CRDT items from a prior
 * server instance can never be hydrated into a provider that will
 * sync with the current server.
 *
 * `UNKNOWN_BRANCH_SENTINEL` is the placeholder used when the pool has
 * not yet observed a branch (cold-boot tab with no persisted
 * `lastObservedBranch`). The IDB at the sentinel name will be empty
 * (never written to in production); auth-token mismatch on first
 * connect drives the recycle to the correct branch-prefixed name.
 *
 * `serverInstanceId` is required and has no sentinel: a non-empty
 * value MUST be supplied. Callers that don't yet know the live server
 * epoch must defer construction of this primitive until they do.
 *
 * Origin filtering (no write-back loop) is inherent to upstream
 * `y-indexeddb`: its `_storeUpdate` listener short-circuits when the
 * update origin equals the persistence instance itself, which is the
 * origin it passes to `Y.transact` during hydration.
 */

import { LINEAGE_EPOCH_KEY } from '@inkeep/open-knowledge-core';
import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';
import { mark } from '@/lib/perf';

/**
 * Object-store names mirroring the pinned+patched `y-indexeddb@9.0.12`
 * schema (`updatesStoreName` / `customStoreName` in its source). Every
 * direct IDB access in this file (the peek, `flushFullState`) is coupled
 * to this shape; drift surfaces fail-loud at upgrade time via
 * `patchedDependencies`.
 */
const UPDATES_STORE_NAME = 'updates';
const CUSTOM_STORE_NAME = 'custom';

/**
 * Defense-in-depth gate. Marks are cheap (`performance.measure` + a no-op
 * collector push in PROD per `mark.ts`) but emitting an `idb-*` span on every
 * IDB hydrate / destroy / clearData call in PROD is unnecessary. PROD short-
 * circuit follows the `__okPerfCounters` pattern in provider-pool.ts.
 */
function instrumentationDisabled(): boolean {
  return import.meta.env?.PROD === true;
}

/**
 * Branch identifier used when no `lastObservedBranch` is available
 * (fresh tab, cleared localStorage) and the boot fetch hasn't yet
 * completed. Mirrors the `__system__` pseudo-doc's leading-and-trailing
 * underscore convention.
 *
 * `_unknown_` is NOT structurally rejected by git — `git branch _unknown_`
 * succeeds. The sentinel is deliberately shaped to be unusual but
 * collision is theoretically possible. Operational impact of a real
 * `_unknown_` branch is zero: the auth-token claim on first connect
 * carries `expectedBranch: '_unknown_'`; if the server's actual branch
 * matches, the IDB is correctly scoped; if not, the
 * `branch-mismatch` recycle path (server's `onAuthenticate` reject →
 * client's `handleServerInstanceMismatch` recycle) reconciles via
 * IDB clear + fresh provider, which is the same recovery used for any
 * other stale-claim scenario.
 *
 * Storage hygiene caveat: `ok-ydoc:_unknown_:<docName>` IDBs may
 * accumulate when the cold-tab branch-mismatch recovery fails before
 * the IDB is cleared. Two failure paths leave orphans:
 *
 *   1. `/api/server-info` unreachable (network blip, server still
 *      booting) — `DocumentContext.tsx`'s mismatch handler logs
 *      `branch-mismatch-recovery-failed` and skips the recycle.
 *   2. Tab close mid-recycle — destroy chain doesn't await the
 *      `clearData` promise.
 *
 * Each failed-recovery cycle leaves at most one `_unknown_`-prefixed
 * IDB per docName (same docName overwrites). Bounded by docName
 * cardinality; harmless under browser quota; not a correctness bug
 * (all of these IDBs would correctly trigger `branch-mismatch` on
 * the next session and be cleared via the recycle path). Documented
 * here following the `localStorage`+IDB co-eviction precedent at
 * `provider-pool.ts:lastObservedBranch` — a symmetric storage-hygiene
 * note rather than a code-level cleanup. Opportunistic enumeration
 * via `indexedDB.databases()` was considered but rejected: the
 * cleanup path could race a mid-recovery reuse of the sentinel-
 * prefixed IDB and delete an in-use database.
 */
export const UNKNOWN_BRANCH_SENTINEL = '_unknown_';

export interface ClientPersistenceProvider {
  readonly whenSynced: Promise<this>;
  readonly synced: boolean;
  destroy(): Promise<void>;
  clearData(): Promise<void>;
  /**
   * Persist the doc's FULL current state into the updates store and trim
   * the rows it supersedes, resolving only after the write transaction
   * has committed. Needed when persistence attaches AFTER sync already
   * delivered content: y-indexeddb's incremental `_storeUpdate` listener
   * only captures updates applied after construction, and its
   * hydrate-time full-state write is skipped on an empty store — so a
   * post-sync attach would otherwise leave a cache whose rows reference
   * items it never stored (Yjs `pendingStructs` on the next warm reload,
   * silently degrading the cache to useless).
   */
  flushFullState(): Promise<void>;
}

/**
 * Construction shape for `createClientPersistence`. Object-literal form
 * (rather than positional `(branch, serverInstanceId, docName, doc)`)
 * protects against the confusable-string-arg-swap class of bugs — the
 * three string fields are otherwise indistinguishable to the type
 * system, and a swap would compile cleanly while silently producing
 * the wrong IDB name and defeating the cross-branch / cross-epoch
 * defense.
 */
interface CreateClientPersistenceArgs {
  readonly branch: string;
  readonly serverInstanceId: string;
  readonly docName: string;
  readonly doc: Y.Doc;
}

class ClientPersistenceImpl implements ClientPersistenceProvider {
  private readonly _idb: IndexeddbPersistence;
  private readonly _dbName: string;
  readonly whenSynced: Promise<this>;

  constructor({ branch, serverInstanceId, docName, doc }: CreateClientPersistenceArgs) {
    if (typeof serverInstanceId !== 'string' || serverInstanceId.length === 0) {
      throw new Error(
        'createClientPersistence: serverInstanceId is required and must be non-empty',
      );
    }
    this._dbName = `ok-ydoc:${branch}:${serverInstanceId}:${docName}`;
    const start = instrumentationDisabled() ? 0 : performance.now();
    this._idb = new IndexeddbPersistence(this._dbName, doc);
    this.whenSynced = this._idb.whenSynced.then(() => {
      // Span covers construct → IDB-hydrate-resolve so the cold-LOAD timeline
      // can split into IDB-hydrate / WebSocket-sync / PM-build phases.
      if (!instrumentationDisabled()) {
        const end = performance.now();
        mark(
          'ok/pool/idb-whensynced',
          { docName, durationMs: Math.round((end - start) * 1000) / 1000 },
          { startTime: start, duration: end - start },
        );
      }
      return this;
    });
  }

  get synced(): boolean {
    return this._idb.synced;
  }

  async destroy(): Promise<void> {
    const start = instrumentationDisabled() ? 0 : performance.now();
    try {
      await this._idb.destroy();
    } finally {
      if (!instrumentationDisabled()) {
        const end = performance.now();
        mark(
          'ok/pool/idb-destroy',
          { dbName: this._dbName, durationMs: Math.round((end - start) * 1000) / 1000 },
          { startTime: start, duration: end - start },
        );
      }
    }
  }

  /**
   * Implemented in the wrapper rather than via upstream `storeState`:
   * upstream does not return its inner write chain, so its promise
   * resolves before the full-state row is durably written — an abnormal
   * termination right after the await (tab close) would silently leave
   * exactly the orphan-rows degradation this primitive exists to
   * prevent. One readwrite transaction writes the full state and trims
   * every row it supersedes; `oncomplete` is the resolution gate.
   */
  async flushFullState(): Promise<void> {
    if (this._idb.db === null) {
      await this.whenSynced;
    }
    const db = this._idb.db;
    if (db === null) return;
    const idb = this._idb;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(UPDATES_STORE_NAME, 'readwrite');
      const store = tx.objectStore(UPDATES_STORE_NAME);
      // Fold every stored row into the doc BEFORE encoding (upstream
      // storeState's fetch-apply-then-encode shape): a second tab on the
      // same doc writes incremental rows into this DB, and those updates
      // may not have reached this tab's doc via WS yet — encoding without
      // folding would trim them away unapplied. Re-applying rows this doc
      // already contains is a Yjs no-op; the persistence-instance origin
      // keeps the incremental listener from re-storing the folds. The
      // readwrite transaction holds the store, so fold + write + trim are
      // atomic against other connections.
      const getAllReq = store.getAll();
      getAllReq.onerror = () =>
        reject(getAllReq.error ?? new Error('flushFullState getAll failed'));
      getAllReq.onsuccess = () => {
        // A throw inside an IDB event handler does NOT reject the wrapping
        // promise or abort the transaction by itself — it escapes to the
        // event loop and the promise never settles. Stored rows are
        // corruptible external input (partial prior-session flushes,
        // cross-version encodings), so Y.applyUpdate can genuinely throw:
        // catch and reject so callers' error paths observe the failure
        // instead of hanging. Same trust boundary the peek handles.
        try {
          Y.transact(
            idb.doc,
            () => {
              for (const row of getAllReq.result as unknown[]) {
                Y.applyUpdate(idb.doc, row as Uint8Array);
              }
            },
            idb,
            false,
          );
          const addReq = store.add(Y.encodeStateAsUpdate(idb.doc));
          addReq.onerror = () => reject(addReq.error ?? new Error('flushFullState add failed'));
          addReq.onsuccess = () => {
            // Rows below the new key are now all subsumed by the full state
            // just written; rows added concurrently after it keep their
            // own, higher keys.
            store.delete(IDBKeyRange.upperBound(addReq.result, true));
          };
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          try {
            tx.abort();
          } catch {
            // Transaction may already be aborting/finished; reject above is
            // the load-bearing signal.
          }
        }
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('flushFullState transaction aborted'));
    });
  }

  async clearData(): Promise<void> {
    // Upstream `clearData` chains `destroy().then(() => idb.deleteDB(name))`
    // without awaiting the deletion — so its promise resolves before the
    // IDB database is actually gone, and a subsequent
    // `createClientPersistence(sameDocName, ...)` can race with the
    // pending delete. Await the deletion explicitly so callers can rely on
    // "after `await clearData()`, the DB is gone."
    const start = instrumentationDisabled() ? 0 : performance.now();
    try {
      await this._idb.destroy();
      const dbName = this._dbName;
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.deleteDatabase(dbName);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
        // `onblocked` is a STATUS event, not a terminal one: the request
        // stays pending and fires `onsuccess` once every blocking
        // connection closes (including the same-context pending IDB
        // transactions on the just-`db.close()`-marked connection that
        // typically take a few milliseconds to drain). Logging here keeps
        // the structured event for observability; aborting the request is
        // the caller's job via `withClearDataTimeout` (provider-pool.ts).
        // The historic synchronous `reject` here pre-terminated deletion
        // before pending writes drained — leaving stale IDB rows for the
        // next `IndexeddbPersistence(sameName, ...)` to hydrate, which is
        // exactly the content-duplication bug class clearData is supposed
        // to prevent.
        req.onblocked = () => {
          console.warn(JSON.stringify({ event: 'ok-client-persistence-clear-blocked', dbName }));
        };
      });
    } finally {
      if (!instrumentationDisabled()) {
        const end = performance.now();
        mark(
          'ok/pool/idb-cleardata',
          { dbName: this._dbName, durationMs: Math.round((end - start) * 1000) / 1000 },
          { startTime: start, duration: end - start },
        );
      }
    }
  }
}

export function createClientPersistence(
  args: CreateClientPersistenceArgs,
): ClientPersistenceProvider {
  return new ClientPersistenceImpl(args);
}

/**
 * Args for `peekStoredLineageEpoch`. Object-literal form for the same
 * confusable-string-arg-swap protection as `CreateClientPersistenceArgs`.
 */
export interface PeekStoredLineageEpochArgs {
  readonly branch: string;
  readonly serverInstanceId: string;
  readonly docName: string;
}

/**
 * Read the lineage epoch carried IN-BAND by the stored IndexedDB rows for
 * (branch, serverInstanceId, docName) — without touching any live Y.Doc.
 *
 * The server mints the epoch into the doc's `lifecycle` Y.Map atomically
 * with seeded content, so persisted rows carry their own provenance: the
 * rows are materialized into a throwaway scratch Y.Doc and the epoch read
 * from there. This is what lets the persistence-attach boundary validate
 * stored state against the live lineage even when the localStorage epoch
 * record is absent or unreadable (the record and the rows can detach —
 * independent eviction, instance-unknown boot window — but the epoch
 * cannot detach from the rows it travels with).
 *
 * Returns `null` for "nothing to validate": no database, empty updates
 * store, rows that carry no epoch (written by a pre-epoch server), or an
 * environment without IndexedDB at all.
 *
 * Read-only by contract, with one deliberate carve-out: on engines without
 * `indexedDB.databases()` (Firefox < 126, Safari < 14 — there is no other
 * way to test for existence), peeking a never-persisted doc CREATES its
 * database via the versionless open, so `onupgradeneeded` mirrors
 * y-indexeddb's own store shape (`updates` autoIncrement + `custom`). A
 * bare created DB without those stores would break the later real attach:
 * y-indexeddb also opens versionless, so its store creation never runs
 * against an already-existing database. Store names are coupled to the
 * pinned+patched `y-indexeddb@9.0.12` via the shared module constants
 * (fail-loud via `patchedDependencies` on upgrade).
 *
 * Rows that fail to apply to the scratch doc reject — the caller decides
 * what unreadable stored state means at its boundary.
 */
export async function peekStoredLineageEpoch(
  args: PeekStoredLineageEpochArgs,
): Promise<string | null> {
  if (typeof indexedDB === 'undefined') return null;
  const dbName = `ok-ydoc:${args.branch}:${args.serverInstanceId}:${args.docName}`;
  if (typeof indexedDB.databases === 'function') {
    const dbs = await indexedDB.databases();
    if (!dbs.some((d) => d.name === dbName)) return null;
  }
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(dbName);
    req.onupgradeneeded = () => {
      const created = req.result;
      if (!created.objectStoreNames.contains(UPDATES_STORE_NAME)) {
        created.createObjectStore(UPDATES_STORE_NAME, { autoIncrement: true });
      }
      if (!created.objectStoreNames.contains(CUSTOM_STORE_NAME)) {
        created.createObjectStore(CUSTOM_STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    if (!db.objectStoreNames.contains(UPDATES_STORE_NAME)) return null;
    const updates = await new Promise<unknown[]>((resolve, reject) => {
      const tx = db.transaction(UPDATES_STORE_NAME, 'readonly');
      const getAll = tx.objectStore(UPDATES_STORE_NAME).getAll();
      getAll.onsuccess = () => resolve(getAll.result as unknown[]);
      getAll.onerror = () => reject(getAll.error);
    });
    if (updates.length === 0) return null;
    const scratch = new Y.Doc();
    try {
      Y.transact(scratch, () => {
        for (const update of updates) {
          Y.applyUpdate(scratch, update as Uint8Array);
        }
      });
      const epoch = scratch.getMap('lifecycle').get(LINEAGE_EPOCH_KEY);
      return typeof epoch === 'string' && epoch.length > 0 ? epoch : null;
    } finally {
      scratch.destroy();
    }
  } finally {
    db.close();
  }
}

export function captureStateVector(doc: Y.Doc): Uint8Array {
  return Y.encodeStateVector(doc);
}

export function computeUnsyncedUpdate(doc: Y.Doc, lastAckedSV: Uint8Array | null): Uint8Array {
  return lastAckedSV === null
    ? Y.encodeStateAsUpdate(doc)
    : Y.encodeStateAsUpdate(doc, lastAckedSV);
}

/**
 * Element-wise max-merge of two Yjs state vectors. Conservative under
 * out-of-order receives across independent channels — the server's
 * per-doc SV is monotonic at emit time, but the client receives via
 * two channels (CC1 stateless WS + `/api/server-info` HTTP) that
 * aren't ordered relative to each other. A pure overwrite-on-receive
 * could regress when an older HTTP response lands AFTER a newer WS
 * broadcast (HTTP RTT ~ 30–100 ms; WS frame ~ 5–20 ms; the cross-
 * over window is realistic), reopening the disk-ack staleness
 * duplication path on the next mismatch-recycle.
 *
 * Yjs SVs are `Map<clientID, clock>` shapes encoded as variable-
 * length integers. `Y.decodeStateVector` returns the map; element-
 * wise max picks the larger clock per clientID; `Y.encodeStateVector`
 * accepts a `Map<number, number>` directly (per its public type
 * declaration in `node_modules/yjs/dist/src/utils/encoding.d.ts`),
 * so the round-trip stays in-process and doesn't need a synthetic
 * `Y.Doc`.
 *
 * `null` arg = "no current value"; the other side wins. Both null
 * is degenerate but honored — caller chose this state explicitly.
 */
export function mergeStateVectors(a: Uint8Array | null, b: Uint8Array | null): Uint8Array | null {
  if (a === null) return b;
  if (b === null) return a;
  const mapA = Y.decodeStateVector(a);
  const mapB = Y.decodeStateVector(b);
  const merged = new Map<number, number>();
  for (const [clientID, clock] of mapA) merged.set(clientID, clock);
  for (const [clientID, clock] of mapB) {
    const existing = merged.get(clientID);
    if (existing === undefined || clock > existing) {
      merged.set(clientID, clock);
    }
  }
  return Y.encodeStateVector(merged);
}
