
import { LINEAGE_EPOCH_KEY } from '@inkeep/open-knowledge-core';
import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';
import { mark } from '@/lib/perf';

const UPDATES_STORE_NAME = 'updates';
const CUSTOM_STORE_NAME = 'custom';

function instrumentationDisabled(): boolean {
  return import.meta.env?.PROD === true;
}

export const UNKNOWN_BRANCH_SENTINEL = '_unknown_';

export interface ClientPersistenceProvider {
  readonly whenSynced: Promise<this>;
  readonly synced: boolean;
  destroy(): Promise<void>;
  clearData(): Promise<void>;
  flushFullState(): Promise<void>;
}

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
      const getAllReq = store.getAll();
      getAllReq.onerror = () =>
        reject(getAllReq.error ?? new Error('flushFullState getAll failed'));
      getAllReq.onsuccess = () => {
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
            store.delete(IDBKeyRange.upperBound(addReq.result, true));
          };
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          try {
            tx.abort();
          } catch {
          }
        }
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('flushFullState transaction aborted'));
    });
  }

  async clearData(): Promise<void> {
    const start = instrumentationDisabled() ? 0 : performance.now();
    try {
      await this._idb.destroy();
      const dbName = this._dbName;
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.deleteDatabase(dbName);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
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

export interface PeekStoredLineageEpochArgs {
  readonly branch: string;
  readonly serverInstanceId: string;
  readonly docName: string;
}

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
