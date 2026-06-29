
import { describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import {
  type ClientPersistenceProvider,
  captureStateVector,
  computeUnsyncedUpdate,
  createClientPersistence,
  mergeStateVectors,
  peekStoredLineageEpoch,
} from './client-persistence';

function uniqueDocName(prefix = 'cp-test'): string {
  return `${prefix}-${randomUUID()}`;
}

const TEST_BRANCH = 'main';

const TEST_SERVER_INSTANCE_ID = 'test-server-instance';

async function countPersistedUpdates(
  branch: string,
  serverInstanceId: string,
  docName: string,
): Promise<number> {
  const dbName = `ok-ydoc:${branch}:${serverInstanceId}:${docName}`;
  const dbs = await indexedDB.databases();
  if (!dbs.some((d) => d.name === dbName)) return 0;

  return new Promise<number>((resolve, reject) => {
    const req = indexedDB.open(dbName);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('updates')) {
        db.close();
        resolve(0);
        return;
      }
      try {
        const tx = db.transaction('updates', 'readonly');
        const store = tx.objectStore('updates');
        const countReq = store.count();
        countReq.onsuccess = () => {
          db.close();
          resolve(countReq.result);
        };
        countReq.onerror = () => {
          db.close();
          reject(countReq.error);
        };
      } catch (err) {
        db.close();
        if ((err as Error)?.name === 'NotFoundError') {
          resolve(0);
          return;
        }
        reject(err);
      }
    };
  });
}

async function readPersistedUpdates(
  branch: string,
  serverInstanceId: string,
  docName: string,
): Promise<unknown[]> {
  const dbName = `ok-ydoc:${branch}:${serverInstanceId}:${docName}`;
  const dbs = await indexedDB.databases();
  if (!dbs.some((d) => d.name === dbName)) return [];

  return new Promise<unknown[]>((resolve, reject) => {
    const req = indexedDB.open(dbName);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('updates')) {
        db.close();
        resolve([]);
        return;
      }
      const tx = db.transaction('updates', 'readonly');
      const getAll = tx.objectStore('updates').getAll();
      getAll.onsuccess = () => {
        db.close();
        resolve(getAll.result as unknown[]);
      };
      getAll.onerror = () => {
        db.close();
        reject(getAll.error);
      };
    };
  });
}

describe('createClientPersistence', () => {
  test('creates provider for empty IDB and emits synced event', async () => {
    const docName = uniqueDocName();
    const doc = new Y.Doc();
    const provider: ClientPersistenceProvider = createClientPersistence({
      branch: TEST_BRANCH,
      serverInstanceId: TEST_SERVER_INSTANCE_ID,
      docName,
      doc,
    });

    expect(provider.synced).toBe(false);

    const resolved = await provider.whenSynced;

    expect(provider.synced).toBe(true);
    expect(resolved).toBe(provider);

    await provider.destroy();
    doc.destroy();
  });

  test('persists updates across destroy then re-open with same docName', async () => {
    const docName = uniqueDocName();

    const docA = new Y.Doc();
    const providerA = createClientPersistence({
      branch: TEST_BRANCH,
      serverInstanceId: TEST_SERVER_INSTANCE_ID,
      docName,
      doc: docA,
    });
    await providerA.whenSynced;
    docA.getMap('m').set('greeting', 'hello-persistence');
    docA.getArray('a').push(['one', 'two']);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await providerA.destroy();
    docA.destroy();

    const docB = new Y.Doc();
    const providerB = createClientPersistence({
      branch: TEST_BRANCH,
      serverInstanceId: TEST_SERVER_INSTANCE_ID,
      docName,
      doc: docB,
    });
    await providerB.whenSynced;

    expect(docB.getMap('m').get('greeting')).toBe('hello-persistence');
    expect(docB.getArray('a').toArray()).toEqual(['one', 'two']);

    await providerB.destroy();
    docB.destroy();
  });

  test('hydration does not re-write already-persisted updates (self-origin filter)', async () => {
    const docName = uniqueDocName();

    const docA = new Y.Doc();
    const providerA = createClientPersistence({
      branch: TEST_BRANCH,
      serverInstanceId: TEST_SERVER_INSTANCE_ID,
      docName,
      doc: docA,
    });
    await providerA.whenSynced;
    docA.getText('t').insert(0, 'a');
    docA.getText('t').insert(1, 'b');
    docA.getText('t').insert(2, 'c');
    docA.getText('t').insert(3, 'd');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await providerA.destroy();
    docA.destroy();

    const countBeforeHydrate = await countPersistedUpdates(
      TEST_BRANCH,
      TEST_SERVER_INSTANCE_ID,
      docName,
    );
    expect(countBeforeHydrate).toBeGreaterThanOrEqual(4);

    const docB = new Y.Doc();
    const providerB = createClientPersistence({
      branch: TEST_BRANCH,
      serverInstanceId: TEST_SERVER_INSTANCE_ID,
      docName,
      doc: docB,
    });
    await providerB.whenSynced;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const countAfterHydrate = await countPersistedUpdates(
      TEST_BRANCH,
      TEST_SERVER_INSTANCE_ID,
      docName,
    );
    expect(countAfterHydrate).toBe(countBeforeHydrate + 1);
    expect(docB.getText('t').toString()).toBe('abcd');

    await providerB.destroy();
    docB.destroy();
  });

  test('clearData wipes persisted updates', async () => {
    const docName = uniqueDocName();

    const docA = new Y.Doc();
    const providerA = createClientPersistence({
      branch: TEST_BRANCH,
      serverInstanceId: TEST_SERVER_INSTANCE_ID,
      docName,
      doc: docA,
    });
    await providerA.whenSynced;
    docA.getText('t').insert(0, 'will be wiped');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(
      await countPersistedUpdates(TEST_BRANCH, TEST_SERVER_INSTANCE_ID, docName),
    ).toBeGreaterThan(0);

    await providerA.clearData();
    docA.destroy();

    expect(await countPersistedUpdates(TEST_BRANCH, TEST_SERVER_INSTANCE_ID, docName)).toBe(0);

    const docB = new Y.Doc();
    const providerB = createClientPersistence({
      branch: TEST_BRANCH,
      serverInstanceId: TEST_SERVER_INSTANCE_ID,
      docName,
      doc: docB,
    });
    await providerB.whenSynced;

    expect(docB.getText('t').toString()).toBe('');

    await providerB.destroy();
    docB.destroy();
  });

  test('clearData onblocked logs structured event and settles via onsuccess once blocker closes', async () => {
    const docName = uniqueDocName('cp-onblocked');
    const dbName = `ok-ydoc:${TEST_BRANCH}:${TEST_SERVER_INSTANCE_ID}:${docName}`;

    const docA = new Y.Doc();
    const provider = createClientPersistence({
      branch: TEST_BRANCH,
      serverInstanceId: TEST_SERVER_INSTANCE_ID,
      docName,
      doc: docA,
    });
    await provider.whenSynced;
    docA.getText('t').insert(0, 'will-be-cleared');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(
      await countPersistedUpdates(TEST_BRANCH, TEST_SERVER_INSTANCE_ID, docName),
    ).toBeGreaterThan(0);

    const blocker: IDBDatabase = await new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const clearPromise = provider.clearData();

      const settled = await Promise.race([
        clearPromise.then(
          () => 'resolved' as const,
          () => 'rejected' as const,
        ),
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50)),
      ]);
      expect(settled).toBe('pending');

      const events = warnSpy.mock.calls.map((call) => String(call[0] ?? ''));
      const blockedWarn = events.find((s) =>
        s.includes('"event":"ok-client-persistence-clear-blocked"'),
      );
      expect(blockedWarn).toBeDefined();
      expect(blockedWarn).toContain(dbName);

      blocker.close();
      await clearPromise;

      expect(await countPersistedUpdates(TEST_BRANCH, TEST_SERVER_INSTANCE_ID, docName)).toBe(0);
    } finally {
      warnSpy.mockRestore();
      try {
        blocker.close();
      } catch {
      }
      docA.destroy();
    }
  });

  test('destroy preserves persisted data for the next open', async () => {
    const docName = uniqueDocName();

    const docA = new Y.Doc();
    const providerA = createClientPersistence({
      branch: TEST_BRANCH,
      serverInstanceId: TEST_SERVER_INSTANCE_ID,
      docName,
      doc: docA,
    });
    await providerA.whenSynced;
    docA.getText('t').insert(0, 'survive-destroy');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await providerA.destroy();
    docA.destroy();

    expect(
      await countPersistedUpdates(TEST_BRANCH, TEST_SERVER_INSTANCE_ID, docName),
    ).toBeGreaterThan(0);

    const docB = new Y.Doc();
    const providerB = createClientPersistence({
      branch: TEST_BRANCH,
      serverInstanceId: TEST_SERVER_INSTANCE_ID,
      docName,
      doc: docB,
    });
    await providerB.whenSynced;
    expect(docB.getText('t').toString()).toBe('survive-destroy');

    await providerB.destroy();
    docB.destroy();
  });

  test('throws synchronously when serverInstanceId is empty', () => {
    const docName = uniqueDocName();
    const doc = new Y.Doc();
    expect(() =>
      createClientPersistence({
        branch: TEST_BRANCH,
        serverInstanceId: '',
        docName,
        doc,
      }),
    ).toThrow('serverInstanceId is required');
    doc.destroy();
  });

  test('DB-name derivation is unique per (branch, serverInstanceId, docName)', async () => {
    const docName = uniqueDocName('db-name');
    const triples = [
      { branch: 'main', serverInstanceId: 'epoch-A' },
      { branch: 'feature', serverInstanceId: 'epoch-A' },
      { branch: 'main', serverInstanceId: 'epoch-B' },
    ];

    for (const { branch, serverInstanceId } of triples) {
      const doc = new Y.Doc();
      const provider = createClientPersistence({ branch, serverInstanceId, docName, doc });
      await provider.whenSynced;
      doc.getText('t').insert(0, `${branch}-${serverInstanceId}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await provider.destroy();
      doc.destroy();
    }

    const dbs = await indexedDB.databases();
    const observedNames = new Set(
      dbs.map((d) => d.name).filter((n): n is string => n !== undefined),
    );
    for (const { branch, serverInstanceId } of triples) {
      const expected = `ok-ydoc:${branch}:${serverInstanceId}:${docName}`;
      expect(observedNames.has(expected)).toBe(true);
    }
  });

  test('ignores legacy ok-ydoc:branch:docName DB shape — new shape hydrates empty', async () => {
    const docName = uniqueDocName('legacy-shape');
    const legacyDbName = `ok-ydoc:${TEST_BRANCH}:${docName}`;

    const stagingDoc = new Y.Doc();
    stagingDoc.getText('t').insert(0, 'stale-from-legacy-shape');
    const staleBytes = Y.encodeStateAsUpdate(stagingDoc);
    stagingDoc.destroy();

    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(legacyDbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('updates')) {
          db.createObjectStore('updates', { autoIncrement: true });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('updates', 'readwrite');
        tx.objectStore('updates').add(staleBytes);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      };
      req.onerror = () => reject(req.error);
    });

    const doc = new Y.Doc();
    const provider = createClientPersistence({
      branch: TEST_BRANCH,
      serverInstanceId: TEST_SERVER_INSTANCE_ID,
      docName,
      doc,
    });
    await provider.whenSynced;

    expect(doc.getText('t').toString()).toBe('');

    await provider.destroy();
    doc.destroy();
  });
});

describe('peekStoredLineageEpoch', () => {
  test('returns null when no database exists, without breaking a later attach', async () => {
    const docName = uniqueDocName('cp-peek-absent');
    const peeked = await peekStoredLineageEpoch({
      branch: TEST_BRANCH,
      serverInstanceId: TEST_SERVER_INSTANCE_ID,
      docName,
    });
    expect(peeked).toBeNull();

    const doc = new Y.Doc();
    const provider = createClientPersistence({
      branch: TEST_BRANCH,
      serverInstanceId: TEST_SERVER_INSTANCE_ID,
      docName,
      doc,
    });
    await provider.whenSynced;
    doc.getText('t').insert(0, 'post-peek attach works');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await provider.destroy();
    doc.destroy();

    const docB = new Y.Doc();
    const providerB = createClientPersistence({
      branch: TEST_BRANCH,
      serverInstanceId: TEST_SERVER_INSTANCE_ID,
      docName,
      doc: docB,
    });
    await providerB.whenSynced;
    expect(docB.getText('t').toString()).toBe('post-peek attach works');
    await providerB.destroy();
    docB.destroy();
  });

  test('reads the epoch carried in-band by the stored rows', async () => {
    const docName = uniqueDocName('cp-peek-epoch');
    const doc = new Y.Doc();
    const provider = createClientPersistence({
      branch: TEST_BRANCH,
      serverInstanceId: TEST_SERVER_INSTANCE_ID,
      docName,
      doc,
    });
    await provider.whenSynced;
    doc.getMap('lifecycle').set('epoch', 'epoch-stored');
    doc.getText('source').insert(0, 'content under epoch-stored');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await provider.destroy();
    doc.destroy();

    const peeked = await peekStoredLineageEpoch({
      branch: TEST_BRANCH,
      serverInstanceId: TEST_SERVER_INSTANCE_ID,
      docName,
    });
    expect(peeked).toBe('epoch-stored');
  });

  test('returns null for rows that carry no epoch (pre-epoch writer)', async () => {
    const docName = uniqueDocName('cp-peek-noepoch');
    const doc = new Y.Doc();
    const provider = createClientPersistence({
      branch: TEST_BRANCH,
      serverInstanceId: TEST_SERVER_INSTANCE_ID,
      docName,
      doc,
    });
    await provider.whenSynced;
    doc.getText('source').insert(0, 'offline-first content, no lifecycle epoch');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await provider.destroy();
    doc.destroy();

    const peeked = await peekStoredLineageEpoch({
      branch: TEST_BRANCH,
      serverInstanceId: TEST_SERVER_INSTANCE_ID,
      docName,
    });
    expect(peeked).toBeNull();
  });

  test('does not mutate the stored rows (read-only contract)', async () => {
    const docName = uniqueDocName('cp-peek-readonly');
    const doc = new Y.Doc();
    const provider = createClientPersistence({
      branch: TEST_BRANCH,
      serverInstanceId: TEST_SERVER_INSTANCE_ID,
      docName,
      doc,
    });
    await provider.whenSynced;
    doc.getMap('lifecycle').set('epoch', 'epoch-ro');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await provider.destroy();
    doc.destroy();

    const before = await countPersistedUpdates(TEST_BRANCH, TEST_SERVER_INSTANCE_ID, docName);
    await peekStoredLineageEpoch({
      branch: TEST_BRANCH,
      serverInstanceId: TEST_SERVER_INSTANCE_ID,
      docName,
    });
    const after = await countPersistedUpdates(TEST_BRANCH, TEST_SERVER_INSTANCE_ID, docName);
    expect(after).toBe(before);
  });
});

describe('flushFullState', () => {
  test('persists content the incremental listener never saw (post-sync attach gap-fill)', async () => {
    const docName = uniqueDocName('cp-flush');
    const doc = new Y.Doc();
    doc.getText('source').insert(0, 'delivered before attach');
    const provider = createClientPersistence({
      branch: TEST_BRANCH,
      serverInstanceId: TEST_SERVER_INSTANCE_ID,
      docName,
      doc,
    });
    await provider.whenSynced;
    await provider.flushFullState?.();
    await provider.destroy();
    doc.destroy();

    const docB = new Y.Doc();
    const providerB = createClientPersistence({
      branch: TEST_BRANCH,
      serverInstanceId: TEST_SERVER_INSTANCE_ID,
      docName,
      doc: docB,
    });
    await providerB.whenSynced;
    expect(docB.getText('source').toString()).toBe('delivered before attach');
    await providerB.destroy();
    docB.destroy();
  });

  test('resolves only after the full-state row is committed and superseded rows are trimmed', async () => {
    const docName = uniqueDocName('cp-flush-durable');
    const doc = new Y.Doc();
    const provider = createClientPersistence({
      branch: TEST_BRANCH,
      serverInstanceId: TEST_SERVER_INSTANCE_ID,
      docName,
      doc,
    });
    await provider.whenSynced;
    doc.getText('source').insert(0, 'a');
    doc.getText('source').insert(1, 'b');

    await provider.flushFullState();

    const rows = await readPersistedUpdates(TEST_BRANCH, TEST_SERVER_INSTANCE_ID, docName);
    expect(rows.length).toBe(1);
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, rows[0] as Uint8Array);
    expect(fresh.getText('source').toString()).toBe('ab');
    fresh.destroy();

    await provider.destroy();
    doc.destroy();
  });

  test('rejects instead of hanging when a stored row is malformed', async () => {
    const docName = uniqueDocName('cp-flush-malformed');
    const doc = new Y.Doc();
    const provider = createClientPersistence({
      branch: TEST_BRANCH,
      serverInstanceId: TEST_SERVER_INSTANCE_ID,
      doc,
      docName,
    });
    await provider.whenSynced;
    doc.getText('source').insert(0, 'healthy');
    const dbName = `ok-ydoc:${TEST_BRANCH}:${TEST_SERVER_INSTANCE_ID}:${docName}`;
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('updates', 'readwrite');
        tx.objectStore('updates').add(new Uint8Array([255, 255, 255]));
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error);
        };
      };
    });

    await expect(provider.flushFullState()).rejects.toThrow();

    await provider.destroy();
    doc.destroy();
  });
});

describe('peekStoredLineageEpoch without indexedDB.databases()', () => {
  async function withoutDatabasesEnumeration(run: () => Promise<void>): Promise<void> {
    const factory = indexedDB as unknown as Record<string, unknown>;
    const original = factory.databases;
    factory.databases = undefined;
    try {
      await run();
    } finally {
      factory.databases = original;
    }
  }

  test('peek of a never-persisted doc returns null', async () => {
    await withoutDatabasesEnumeration(async () => {
      const docName = uniqueDocName('cp-peek-nodbs-null');
      const epoch = await peekStoredLineageEpoch({
        branch: TEST_BRANCH,
        serverInstanceId: TEST_SERVER_INSTANCE_ID,
        docName,
      });
      expect(epoch).toBeNull();
    });
  });

  test('a peek-created DB does not break the later real attach, and a second peek reads its rows', async () => {
    await withoutDatabasesEnumeration(async () => {
      const docName = uniqueDocName('cp-peek-nodbs-attach');
      const first = await peekStoredLineageEpoch({
        branch: TEST_BRANCH,
        serverInstanceId: TEST_SERVER_INSTANCE_ID,
        docName,
      });
      expect(first).toBeNull();

      const doc = new Y.Doc();
      const provider = createClientPersistence({
        branch: TEST_BRANCH,
        serverInstanceId: TEST_SERVER_INSTANCE_ID,
        docName,
        doc,
      });
      await provider.whenSynced;
      doc.getText('source').insert(0, 'written after peek-created DB');
      doc.getMap('lifecycle').set('epoch', 'epoch-nodbs');
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await provider.destroy();
      doc.destroy();

      const docB = new Y.Doc();
      const providerB = createClientPersistence({
        branch: TEST_BRANCH,
        serverInstanceId: TEST_SERVER_INSTANCE_ID,
        docName,
        doc: docB,
      });
      await providerB.whenSynced;
      expect(docB.getText('source').toString()).toBe('written after peek-created DB');
      await providerB.destroy();
      docB.destroy();

      const second = await peekStoredLineageEpoch({
        branch: TEST_BRANCH,
        serverInstanceId: TEST_SERVER_INSTANCE_ID,
        docName,
      });
      expect(second).toBe('epoch-nodbs');
    });
  });
});

describe('captureStateVector', () => {
  test('returns a non-empty Uint8Array for a non-empty doc', () => {
    const doc = new Y.Doc();
    doc.getText('t').insert(0, 'some content');

    const sv = captureStateVector(doc);

    expect(sv).toBeInstanceOf(Uint8Array);
    expect(sv.byteLength).toBeGreaterThan(0);

    doc.destroy();
  });
});

describe('computeUnsyncedUpdate', () => {
  test('with null lastAckedSV returns the full state update', () => {
    const doc = new Y.Doc();
    doc.getText('t').insert(0, 'full');

    const fromHelper = computeUnsyncedUpdate(doc, null);
    const full = Y.encodeStateAsUpdate(doc);

    expect(fromHelper).toEqual(full);

    doc.destroy();
  });

  test('round-trips: applying delta onto a peer at last-synced state yields equivalent content', () => {
    const ackSnapshot = (() => {
      const doc = new Y.Doc();
      doc.getText('t').insert(0, 'acked-baseline');
      const update = Y.encodeStateAsUpdate(doc);
      doc.destroy();
      return update;
    })();

    const clientDoc = new Y.Doc();
    Y.applyUpdate(clientDoc, ackSnapshot);
    const lastAckedSV = captureStateVector(clientDoc);
    clientDoc.getText('t').insert(14, ' + burst');

    const delta = computeUnsyncedUpdate(clientDoc, lastAckedSV);
    expect(delta.byteLength).toBeGreaterThan(0);

    const peerDoc = new Y.Doc();
    Y.applyUpdate(peerDoc, ackSnapshot);
    expect(peerDoc.getText('t').toString()).toBe('acked-baseline');

    Y.applyUpdate(peerDoc, delta);
    expect(peerDoc.getText('t').toString()).toBe(clientDoc.getText('t').toString());

    clientDoc.destroy();
    peerDoc.destroy();
  });
});

describe('mergeStateVectors', () => {
  test('returns the non-null arg when one side is null', () => {
    const doc = new Y.Doc();
    doc.getText('t').insert(0, 'hello');
    const sv = Y.encodeStateVector(doc);
    expect(mergeStateVectors(null, sv)).toBe(sv);
    expect(mergeStateVectors(sv, null)).toBe(sv);
    expect(mergeStateVectors(null, null)).toBeNull();
    doc.destroy();
  });

  test('strictly-dominating SV wins regardless of arg order', () => {
    const doc = new Y.Doc();
    doc.getText('t').insert(0, 'A');
    const svAfterA = Y.encodeStateVector(doc);
    doc.getText('t').insert(1, 'B');
    const svAfterAB = Y.encodeStateVector(doc);
    doc.destroy();

    expect(mergeStateVectors(svAfterA, svAfterAB)).toEqual(svAfterAB);
    expect(mergeStateVectors(svAfterAB, svAfterA)).toEqual(svAfterAB);
  });

  test('union-merges disjoint clientID sets', () => {
    const docA = new Y.Doc();
    docA.getText('t').insert(0, 'A1');
    const svA = Y.encodeStateVector(docA);
    const clientA = docA.clientID;
    docA.destroy();

    const docB = new Y.Doc();
    docB.getText('t').insert(0, 'B1');
    const svB = Y.encodeStateVector(docB);
    const clientB = docB.clientID;
    docB.destroy();

    expect(clientA).not.toBe(clientB);

    const merged = mergeStateVectors(svA, svB);
    if (merged === null) throw new Error('expected merged SV');
    const decoded = Y.decodeStateVector(merged);
    expect(decoded.has(clientA)).toBe(true);
    expect(decoded.has(clientB)).toBe(true);
  });

  test('same-clientID picks the larger clock', () => {
    const doc = new Y.Doc();
    doc.getText('t').insert(0, 'A');
    const svAfterA = Y.encodeStateVector(doc);
    doc.getText('t').insert(1, 'B');
    doc.getText('t').insert(2, 'C');
    const svAfterABC = Y.encodeStateVector(doc);
    const clientID = doc.clientID;
    doc.destroy();

    const mapA = Y.decodeStateVector(svAfterA);
    const mapABC = Y.decodeStateVector(svAfterABC);
    const clockAfterA = mapA.get(clientID);
    const clockAfterABC = mapABC.get(clientID);
    if (clockAfterA === undefined || clockAfterABC === undefined) {
      throw new Error('expected clocks');
    }
    expect(clockAfterABC).toBeGreaterThan(clockAfterA);

    const merged = mergeStateVectors(svAfterA, svAfterABC);
    if (merged === null) throw new Error('expected merged SV');
    const mergedMap = Y.decodeStateVector(merged);
    expect(mergedMap.get(clientID)).toBe(clockAfterABC);
  });

  test('merging an SV with itself is idempotent', () => {
    const doc = new Y.Doc();
    doc.getText('t').insert(0, 'idempotent');
    const sv = Y.encodeStateVector(doc);
    doc.destroy();
    expect(mergeStateVectors(sv, sv)).toEqual(sv);
  });
});

describe('flushFullState cross-tab fold', () => {
  test('folds cross-tab rows into the full state instead of trimming them away', async () => {
    const docName = uniqueDocName('cp-flush-crosstab');
    const doc = new Y.Doc();
    const provider = createClientPersistence({
      branch: TEST_BRANCH,
      serverInstanceId: TEST_SERVER_INSTANCE_ID,
      docName,
      doc,
    });
    await provider.whenSynced;
    doc.getText('source').insert(0, 'tab-a edit\n');

    const otherTab = new Y.Doc();
    otherTab.getText('other').insert(0, 'tab-b edit not yet synced');
    const otherTabRow = Y.encodeStateAsUpdate(otherTab);
    otherTab.destroy();
    const dbName = `ok-ydoc:${TEST_BRANCH}:${TEST_SERVER_INSTANCE_ID}:${docName}`;
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('updates', 'readwrite');
        tx.objectStore('updates').add(otherTabRow);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error);
        };
      };
    });

    await provider.flushFullState();

    const rows = await readPersistedUpdates(TEST_BRANCH, TEST_SERVER_INSTANCE_ID, docName);
    expect(rows.length).toBe(1);
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, rows[0] as Uint8Array);
    expect(fresh.getText('source').toString()).toBe('tab-a edit\n');
    expect(fresh.getText('other').toString()).toBe('tab-b edit not yet synced');
    fresh.destroy();
    expect(doc.getText('other').toString()).toBe('tab-b edit not yet synced');

    await provider.destroy();
    doc.destroy();
  });
});
