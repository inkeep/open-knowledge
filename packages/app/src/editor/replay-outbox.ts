/**
 * The project component is REQUIRED for every desktop window, and omitted only for a null
 * namespace, where the origin already isolates — that is `precedent #59`, applied here through
 * `scopedStorageKey` (`lib/storage-scope.ts`), not re-derived.
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
