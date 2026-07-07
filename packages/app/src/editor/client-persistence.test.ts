/**
 * Unit tests for the client-persistence primitive — the typed wrapper
 * around `y-indexeddb`'s `IndexeddbPersistence` that exposes
 * origin-filtered persistence + state-vector helpers for buffer-and-replay
 * across mismatch-recycle.
 *
 * Runs under Bun with the `fake-indexeddb/auto` preload configured in
 * `packages/app/bunfig.toml` — no real browser IDB needed.
 *
 * Test isolation is via unique doc names (randomUUID) rather than wiping
 * `indexedDB` between tests, because fake-indexeddb's global state persists
 * across a `bun test` process.
 */

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

// Branch used by tests that don't exercise the cross-branch axis. Real
// production callers always pass the observed branch via the pool; tests
// mostly only care that persistence works for SOME branch.
const TEST_BRANCH = 'main';

// Server-instance epoch used by tests that don't exercise the cross-epoch
// axis. Production callers thread the live `cachedServerInstanceId`; the
// epoch is now part of the IDB DB name so stale CRDT state from a prior
// server incarnation can't be hydrated into a fresh-server provider.
const TEST_SERVER_INSTANCE_ID = 'test-server-instance';

async function countPersistedUpdates(
  branch: string,
  serverInstanceId: string,
  docName: string,
): Promise<number> {
  const dbName = `ok-ydoc:${branch}:${serverInstanceId}:${docName}`;
  // Calling `indexedDB.open(dbName)` without a version on a DB that doesn't
  // exist creates a brand-new empty v1 DB with no object stores — which is
  // a destructive side effect for our test scenarios (the subsequent
  // `createClientPersistence` would then see v1 without the schema and
  // `onupgradeneeded` would NOT fire, breaking hydration). Check via
  // `databases()` first and short-circuit when the DB is absent.
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

/**
 * Read the raw `updates`-store rows through a fresh connection — the
 * observer for "what would a cold reload actually hydrate right now".
 */
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
    // Wait a microtask tick so the upstream _storeUpdate listener flushes
    // the write to fake-indexeddb before we tear down.
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
    // Upstream y-indexeddb writes ONE consolidation snapshot per hydration
    // when existing updates are present (patched issue #31). The
    // self-origin filter (`origin !== this` in `_storeUpdate`) is what
    // prevents the N individual stored updates from being re-written as
    // the doc receives them during `fetchUpdates` — otherwise each mount
    // would multiply IDB growth by N.
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
    // Without the filter, the N hydrated updates would be re-written
    // (producing linear growth in N). With it, only the consolidation
    // snapshot from the patched `beforeApplyUpdatesCallback` is added.
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

  // clearData's deleteDatabase request fires `onblocked` when a concurrent
  // connection is still open against the same DB name. The IDB-spec-correct
  // semantic is to log a structured `ok-client-persistence-clear-blocked`
  // event there and let the request settle naturally (onsuccess fires once
  // every blocker closes). The historic synchronous reject() pre-terminated
  // the deletion and left stale rows for the next provider to hydrate,
  // defeating clearData's content-duplication-prevention contract. Pinned
  // via real fake-indexeddb (mocking deleteDatabase would be mock-tautology
  // since the SUT is exactly the wiring of onsuccess/onblocked/onerror
  // handlers).
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

    // Open a raw second connection to dbName. The provider's clearData call
    // will internally close its own connection but the second raw connection
    // remains open and blocks deleteDatabase until we explicitly close it.
    const blocker: IDBDatabase = await new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // Kick off clearData without awaiting. The internal deleteDatabase
      // request is blocked by `blocker` — onblocked fires, the request stays
      // pending (does NOT synchronously reject).
      const clearPromise = provider.clearData();

      // Microtask window: assert the promise has neither rejected nor
      // resolved. The race resolves with 'pending' after a short wait if
      // clearPromise is still in flight; with 'resolved'/'rejected'
      // otherwise. We expect 'pending' — the historic onblocked-reject
      // would resolve to 'rejected' here.
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
      // dbName payload preserves diagnostic context for operators.
      expect(blockedWarn).toContain(dbName);

      // Close the blocking connection; deleteDatabase's onsuccess fires
      // and clearData resolves naturally.
      blocker.close();
      await clearPromise;

      // Rows actually gone — the durable contract is "after await
      // clearData() resolves, the DB is absent" (not merely "destroy
      // pretended").
      expect(await countPersistedUpdates(TEST_BRANCH, TEST_SERVER_INSTANCE_ID, docName)).toBe(0);
    } finally {
      warnSpy.mockRestore();
      try {
        blocker.close();
      } catch {
        // Already closed in happy path.
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

    // Destroy is supposed to unhook without deleting — data must remain.
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

  // Different (branch, serverInstanceId, docName) triples must map to
  // distinct DB names — that's what gives the cache its cross-branch /
  // cross-epoch isolation. Construct one provider per triple and confirm
  // each produces an independent IDB whose name embeds all three keys.
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

  // Old-shape DBs (legacy `ok-ydoc:<branch>:<docName>`, missing the
  // server epoch slot) MUST be ignored: the new shape mints a
  // different DB name, so a fresh provider hydrates from empty rather
  // than picking up stale CRDT items from a prior server epoch.
  test('ignores legacy ok-ydoc:branch:docName DB shape — new shape hydrates empty', async () => {
    const docName = uniqueDocName('legacy-shape');
    const legacyDbName = `ok-ydoc:${TEST_BRANCH}:${docName}`;

    // Hand-write a single update into a DB at the legacy name. The
    // hydration path keys off the new DB-name shape, so this content
    // must NOT appear in the new-shape provider's Y.Doc.
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

    // The peek must not leave the DB in a shape the real attach can't use
    // (a bare versionless-created DB without y-indexeddb's stores would
    // break hydration silently — onupgradeneeded never re-fires).
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
    // Content lands BEFORE persistence attaches — the shape of a deferred
    // attach where sync already delivered the doc. The incremental
    // listener misses it, and the hydrate-time full-state write is skipped
    // on an empty store, so without the flush the cache holds nothing.
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
    // Two post-attach edits → two incremental rows from y-indexeddb's
    // `_storeUpdate` listener, which the flush must supersede.
    doc.getText('source').insert(0, 'a');
    doc.getText('source').insert(1, 'b');

    await provider.flushFullState();

    // Durability contract: the moment the await resolves, a separate
    // connection must already see exactly the one committed full-state
    // row (no reliance on an unawaited upstream write chain landing
    // later). The provider is deliberately still open — nothing else
    // gets a chance to flush on its behalf.
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
    // Plant a corrupt row through a separate connection — the shape of a
    // partial prior-session flush. Y.applyUpdate throws on it inside the
    // flush's getAll handler, where an uncaught throw escapes to the event
    // loop and the promise would never settle.
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

// Engines without `indexedDB.databases()` (Firefox < 126, Safari < 14)
// cannot test for DB existence, so the peek's versionless open CREATES the
// database of a never-persisted doc — the one deliberate carve-out from its
// read-only contract. fake-indexeddb implements `databases()`, so every
// other test takes the short-circuit; these stage the carve-out by
// shadowing the method.
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

      // The carve-out created the DB with y-indexeddb's store shape; the
      // real attach must hydrate + persist as if it created it itself.
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

      // The open-existing path (still without `databases()`) reads the
      // in-band epoch out of the rows the attach persisted.
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
    // Two peers start at the same synced state (ackSnapshot). One keeps
    // typing. `computeUnsyncedUpdate` should produce exactly the delta
    // needed to bring the quiet peer up to the active peer's state.
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

  // Element-wise max-merge picks the larger clock per clientID. When
  // one SV strictly dominates the other (every clientID-clock pair is
  // ≥), the merged result equals the dominating SV byte-for-byte.
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

  // Cross-clientID merge: both SVs contribute different clientIDs, the
  // merged SV carries the union of clientID→clock pairs. This is the
  // load-bearing case for the WS+HTTP race (server-side monotonic SVs
  // that interleave writes from multiple authors), but also for any
  // scenario where two channels each carry SVs spanning disjoint
  // clientID sets.
  test('union-merges disjoint clientID sets', () => {
    // Build two docs with distinct clientIDs.
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

    // Sanity: distinct clientIDs (Y.Doc generates random clientIDs).
    expect(clientA).not.toBe(clientB);

    const merged = mergeStateVectors(svA, svB);
    if (merged === null) throw new Error('expected merged SV');
    const decoded = Y.decodeStateVector(merged);
    expect(decoded.has(clientA)).toBe(true);
    expect(decoded.has(clientB)).toBe(true);
  });

  // Same-clientID, larger-clock wins regardless of arg order. Proves
  // the merge actually does element-wise max rather than naive
  // concatenation.
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

  // Idempotence: merging an SV with itself returns the same content.
  test('merging an SV with itself is idempotent', () => {
    const doc = new Y.Doc();
    doc.getText('t').insert(0, 'idempotent');
    const sv = Y.encodeStateVector(doc);
    doc.destroy();
    expect(mergeStateVectors(sv, sv)).toEqual(sv);
  });
});

// Cross-tab safety of the durable flush: a second tab on the same doc
// writes incremental rows into the shared DB, and those updates may not
// have reached this tab's doc via WS when the flush encodes. The flush
// must fold stored rows into the doc before encoding (upstream
// storeState's fetch-apply-then-encode shape) — trimming a row it never
// applied would silently drop the other tab's edit from the cache.
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

    // The second tab's row, written straight into the shared DB; its
    // update has NOT been applied to this tab's doc.
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

    // One surviving full-state row, carrying BOTH tabs' edits — and the
    // live doc now holds the folded remote edit too.
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
