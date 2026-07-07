import './idb-preload';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { ProviderPool } from '../../src/editor/provider-pool';
import {
  assertNoClientIdDrift,
  createRestartableServer,
  pollDiskContentStable,
  pollUntil,
  type RestartableServer,
  seedPoolServerInstanceId,
} from './test-harness';

// Fixture with markers that appear at known counts: 2 `# Test Document`,
// 1 `[[test-doc]]`, 1 `[[asdf]]`. The bug class would double each marker.
const SMALL_FIXTURE = `[[asdf]]

# Test Documentasdfasdf

## Status

Status: complete

## Notes

Notes added by agent.

## Next Steps

Review patch behavior

# Test Document

## Status

Status: complete

## Notes

Notes added by agent.

## Next Steps

Review patch behavior

  Alpha
  Beta
  Gamma

  [[test-doc]]
  [[Nonexistent Page]]

[[blahboop]]

[[asdfasdfasdf]]
`;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
}, 30_000);

/** Seed the fixture on disk and wait for the pool's active provider to reach
 *  synced + zero unsynced changes. Returns the first provider instance so
 *  tests can assert reference identity after a restart. */
async function seedAndSyncSingleClient(
  server: RestartableServer,
  pool: ProviderPool,
  docName: string,
): Promise<import('@hocuspocus/provider').HocuspocusProvider> {
  writeFileSync(join(server.contentDir, `${docName}.md`), SMALL_FIXTURE, 'utf-8');
  pool.open(docName);
  pool.setActive(docName);
  await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);
  await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 10_000, 50);
  // Let persistence settle its load-time reconciledBase. 150ms matches prior
  // test's empirical "just enough" window; the first onStoreDocument-short-circuit
  // needs the reconciledBase set before any unrelated write fires.
  await wait(150);
  const first = pool.getActive()?.provider;
  if (!first) throw new Error('seedAndSyncSingleClient: provider missing after sync');
  return first;
}

describe('ProviderPool reconnects', () => {
  test('browser reload against same server keeps server Y.Doc loaded and avoids IDB duplication', async () => {
    const server = await createRestartableServer();
    cleanups.push(() => server.shutdown());

    const docName = 'reload-doc';
    writeFileSync(join(server.contentDir, `${docName}.md`), SMALL_FIXTURE, 'utf-8');

    const firstPool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    await seedPoolServerInstanceId(server, firstPool);
    await seedAndSyncSingleClient(server, firstPool, docName);
    await wait(300);

    const baseline = readFileSync(join(server.contentDir, `${docName}.md`), 'utf-8');
    const baselineHeadings = (baseline.match(/# Test Document/g) ?? []).length;
    const baselineLinks = (baseline.match(/\[\[test-doc\]\]/g) ?? []).length;
    expect(baselineHeadings).toBe(2);
    expect(baselineLinks).toBe(1);

    // Simulate a browser reload: the old provider is destroyed, but its
    // y-indexeddb state remains available to the next page load.
    firstPool.dispose();
    await wait(100);

    expect(server.instance.hocuspocus.documents.has(docName)).toBe(true);

    const secondPool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => secondPool.dispose());
    await seedPoolServerInstanceId(server, secondPool);
    secondPool.open(docName);
    secondPool.setActive(docName);
    await pollUntil(() => secondPool.getActive()?.provider.isSynced === true, 10_000, 50);
    await wait(300);

    const afterReload = await pollDiskContentStable(
      join(server.contentDir, `${docName}.md`),
      (content) => content.includes('# Test Document') && content.includes('[[test-doc]]'),
      { timeoutMs: 5000, settleMs: 400 },
    );

    expect((afterReload.match(/# Test Document/g) ?? []).length).toBe(baselineHeadings);
    expect((afterReload.match(/\[\[test-doc\]\]/g) ?? []).length).toBe(baselineLinks);
  }, 20_000);

  // Page-reload-after-server-restart: the Vite-restart duplication scenario.
  //
  // When the browser page reloads (Vite restarts the dev server), a fresh
  // ProviderPool is created with cachedServerInstanceId=null in-memory, IDB
  // still holds Y.Doc items from the prior session, and the server has a new
  // instanceId. Epoch-scoped DB names — `ok-ydoc:${branch}:${serverInstanceId}:${docName}` —
  // structurally prevent the prior session's IDB from hydrating into the
  // post-reload provider: the new server epoch resolves to a different
  // database name, so the stale Y.Doc items can never merge with the
  // freshly-loaded server state.
  test('page reload after server restart: epoch-scoped DB name prevents IDB hydration', async () => {
    let server = await createRestartableServer();
    cleanups.push(() => server.shutdown());

    const docName = 'page-reload-doc';
    writeFileSync(join(server.contentDir, `${docName}.md`), SMALL_FIXTURE, 'utf-8');

    // Shared storage stub — simulates localStorage persisting across page
    // loads. Used by the pool's branch-tracking helper; epoch state lives
    // structurally in the IDB DB name.
    const storageMap = new Map<string, string>();
    const storage = {
      getItem: (k: string) => storageMap.get(k) ?? null,
      setItem: (k: string, v: string) => {
        storageMap.set(k, v);
      },
      removeItem: (k: string) => {
        storageMap.delete(k);
      },
    };

    // Session 1: pool connects and syncs under the first server epoch.
    const firstPool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`, { storage });
    const firstServerId = await seedPoolServerInstanceId(server, firstPool);
    await seedAndSyncSingleClient(server, firstPool, docName);
    await wait(300);

    const baseline = readFileSync(join(server.contentDir, `${docName}.md`), 'utf-8');
    const baselineHeadings = (baseline.match(/# Test Document/g) ?? []).length;
    const baselineLinks = (baseline.match(/\[\[test-doc\]\]/g) ?? []).length;
    expect(baselineHeadings).toBe(2);
    expect(baselineLinks).toBe(1);

    // Page reload: destroy the pool (but IDB survives in fake-indexeddb).
    firstPool.dispose();
    await wait(50);

    // Server restarts with a new instanceId.
    server = await server.killAndRestartOnSamePort({ downtimeMs: 500 });
    cleanups.unshift(() => server.shutdown());

    // Session 2: fresh pool simulating a post-reload page. The new epoch's
    // DB name structurally diverges from the first session's, so no IDB
    // hydration of stale Y.Doc items into the new provider is possible.
    const secondPool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`, { storage });
    cleanups.push(() => secondPool.dispose());
    const secondServerId = await seedPoolServerInstanceId(server, secondPool);
    expect(secondServerId).not.toBe(firstServerId);
    secondPool.open(docName);
    secondPool.setActive(docName);
    await pollUntil(() => secondPool.getActive()?.provider.isSynced === true, 10_000, 50);
    await wait(300);

    const afterReload = await pollDiskContentStable(
      join(server.contentDir, `${docName}.md`),
      (c) => c.includes('# Test Document') && c.includes('[[test-doc]]'),
      { timeoutMs: 5000, settleMs: 400 },
    );

    expect((afterReload.match(/# Test Document/g) ?? []).length).toBe(baselineHeadings);
    expect((afterReload.match(/\[\[test-doc\]\]/g) ?? []).length).toBe(baselineLinks);
  }, 30_000);

  // Slow restart >4s: pool.RECYCLE_DEBOUNCE_MS fires, provider is rebuilt,
  //      fresh Y.Doc replaces the stale one, and sync with the fresh server
  //      produces canonical on-disk content.
  test('slow server restart (>4s): pool recycles, no duplication', async () => {
    let server = await createRestartableServer();
    cleanups.push(() => server.shutdown());

    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());
    await seedPoolServerInstanceId(server, pool);

    const firstProvider = await seedAndSyncSingleClient(server, pool, 'test-doc');

    // Baseline fixture counts on disk.
    const baseline = readFileSync(join(server.contentDir, 'test-doc.md'), 'utf-8');
    expect((baseline.match(/\[\[test-doc\]\]/g) ?? []).length).toBe(1);
    expect((baseline.match(/# Test Document/g) ?? []).length).toBe(2);

    // Slow restart — 4.5s downtime exceeds ProviderPool.RECYCLE_DEBOUNCE_MS (4000ms).
    // The pool's recycle timer fires before the new server comes back up, so the
    // client's stale Y.Doc is discarded and a fresh provider connects to the
    // rebuilt server Y.Doc. No clientID drift possible.
    server = await server.killAndRestartOnSamePort({ downtimeMs: 4500 });
    cleanups.unshift(() => server.shutdown());

    // Wait for pool to have recycled (provider reference changed) + resynced.
    await pollUntil(() => pool.getActive()?.provider !== firstProvider, 10_000, 50);
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);

    // Mechanism confirmation: pool recycled as expected for slow-restart path.
    expect(pool.getActive()?.provider).not.toBe(firstProvider);

    // Behavior: disk content matches baseline exactly once (persistence may
    // have re-serialized post-sync; wait for stability via content predicate).
    const afterRestart = await pollDiskContentStable(
      join(server.contentDir, 'test-doc.md'),
      (c) =>
        (c.match(/# Test Document/g) ?? []).length === 2 &&
        (c.match(/\[\[test-doc\]\]/g) ?? []).length === 1,
      { timeoutMs: 8000 },
    );
    expect((afterRestart.match(/\[\[test-doc\]\]/g) ?? []).length).toBe(1);
    expect((afterRestart.match(/# Test Document/g) ?? []).length).toBe(2);
    expect((afterRestart.match(/\[\[asdf\]\]/g) ?? []).length).toBe(1);
    // Test budget rationale: seed (≤2× 10s polls + 150ms) + 4.5s downtime +
    // up to 10s pool-recycle wait + up to 10s sync wait + up to 8s disk-stabilize
    // wait = ~52s theoretical worst-case. Local typical runtime is ~7-8s, but
    // CI runners under load have crossed 45s; 60s gives enough headroom for
    // contention without masking real regressions (a stuck recycle would still
    // fail the inner polls' 10s budgets first).
  }, 60_000);

  // Fast restart <4s: the bug-class repro.
  //
  // The pool's RECYCLE_DEBOUNCE_MS = 4000ms window is designed to absorb typical
  // server restarts (1-3s). Inside that window the existing client Y.Doc survives
  // and reconnects to the freshly-rebuilt server Y.Doc — which has a different
  // clientID. Yjs merges item streams across disjoint clientID sets additively
  // (union, not dedup-by-content), so disk content appears twice after the first
  // persistence flush post-reconnect.
  //
  // This test is expected to FAIL until the fix lands. When a fix makes it pass,
  // the `expect(...).toBe(baseline)` assertions flip from red to green.
  test('REPRO: fast server restart (<4s) keeps the same provider and duplicates content', async () => {
    let server = await createRestartableServer();
    cleanups.push(() => server.shutdown());

    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());
    await seedPoolServerInstanceId(server, pool);

    await seedAndSyncSingleClient(server, pool, 'test-doc');

    // Baseline on disk.
    const baseline = readFileSync(join(server.contentDir, 'test-doc.md'), 'utf-8');
    const baselineTestDocLinks = (baseline.match(/\[\[test-doc\]\]/g) ?? []).length;
    const baselineHeadings = (baseline.match(/# Test Document/g) ?? []).length;
    const baselineAsdfLinks = (baseline.match(/\[\[asdf\]\]/g) ?? []).length;
    expect(baselineTestDocLinks).toBe(1);
    expect(baselineHeadings).toBe(2);
    expect(baselineAsdfLinks).toBe(1);

    // Capture the client's pre-restart clientID set — this is the mechanism
    // baseline. After a clean restart, the client's clientID set should not
    // grow (no new Items got added under a foreign clientID).
    const preRestartClientIds = new Set(pool.getActive()?.provider.document.store.clients.keys());

    // Fast restart — 500ms downtime, well under RECYCLE_DEBOUNCE_MS = 4000.
    // Pre-fix the pool's pending recycle timer would have been cancelled by
    // onSynced and the stale Y.Doc would survive. Post-fix, the server's
    // onAuthenticate rejects on server-instance-mismatch,
    // the client's authenticationFailed handler fires, and every pool entry
    // recycles BEFORE Yjs sync can merge ghost state. Either way the test's
    // real assertion — no content duplication on disk — is the behavior we
    // care about.
    server = await server.killAndRestartOnSamePort({ downtimeMs: 500 });
    cleanups.unshift(() => server.shutdown());

    // Wait for the pool to resume a synced active provider — whether same
    // or fresh (post-fix recycle). The identity check used to
    // gate this test on "bug-class reached," but the fix makes recycling
    // mandatory; a fresh provider is now the correct post-restart shape.
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);

    // Mechanism-level observability: pre-fix the client's clientID set grew
    // (it learned about the server's fresh clientID post-restart). Post-fix
    // the client's Y.Doc has been replaced entirely, so its clientID set
    // reflects the new Y.Doc's clientID — which is itself post-restart. The
    // log stays for debugging; no assertion on same-provider.
    const postRestartClientIds = new Set(pool.getActive()?.provider.document.store.clients.keys());
    const grewBy = postRestartClientIds.size - preRestartClientIds.size;
    console.log('[REPRO] clientID set', {
      preRestart: [...preRestartClientIds],
      postRestart: [...postRestartClientIds],
      grewBy,
    });

    // Behavior-level signal: disk content materializes duplicated after the
    // persistence debounce flushes the merged Y.Doc. Wait for stability — we
    // don't want to sample mid-debounce.
    const afterRestart = await pollDiskContentStable(
      join(server.contentDir, 'test-doc.md'),
      // Accept as "stable" any state that includes at least one copy of each
      // marker — passes for both pre-fix (duplicated) and post-fix (canonical).
      (c) => c.includes('# Test Document') && c.includes('[[test-doc]]'),
      { timeoutMs: 5000, settleMs: 400 },
    );
    const afterTestDocLinks = (afterRestart.match(/\[\[test-doc\]\]/g) ?? []).length;
    const afterHeadings = (afterRestart.match(/# Test Document/g) ?? []).length;
    const afterAsdfLinks = (afterRestart.match(/\[\[asdf\]\]/g) ?? []).length;

    console.log('[REPRO] counts', {
      baseline: {
        testDocLinks: baselineTestDocLinks,
        headings: baselineHeadings,
        asdf: baselineAsdfLinks,
      },
      after: {
        testDocLinks: afterTestDocLinks,
        headings: afterHeadings,
        asdf: afterAsdfLinks,
      },
      diskBytes: afterRestart.length,
    });

    // Expect NO duplication. Currently fails (the bug); the fix must make this pass.
    expect(afterTestDocLinks).toBe(baselineTestDocLinks);
    expect(afterHeadings).toBe(baselineHeadings);
    expect(afterAsdfLinks).toBe(baselineAsdfLinks);

    // Also assert no clientID drift — the mechanism assertion.
    const serverDoc = server.instance.hocuspocus.documents.get('test-doc');
    if (!serverDoc) throw new Error('server doc missing post-restart');
    const activeEntry = pool.getActive();
    if (!activeEntry) throw new Error('pool has no active entry after reconnect');
    assertNoClientIdDrift(
      {
        docName: 'test-doc',
        doc: activeEntry.provider.document,
        ytext: activeEntry.provider.document.getText('source'),
        fragment: activeEntry.provider.document.getXmlFragment('default'),
        provider: activeEntry.provider,
        pauseSync: () => {
          throw new Error('pauseSync not available');
        },
        resumeSync: () => {
          throw new Error('resumeSync not available');
        },
        cleanup: async () => {
          /* pool owns teardown */
        },
      },
      serverDoc,
      'post fast-restart',
    );
  }, 30_000);

  // Unsynced local changes during disconnect/restart.
  //
  // Under `provider.unsyncedChanges > 0`, provider-pool.ts SKIPS the
  // recycle scheduling entirely (not just cancels on reconnect). So the pool
  // ALWAYS keeps the stale Y.Doc in this scenario, regardless of restart timing.
  // The test asserts (a) the local unsynced edit survives and (b) pre-disconnect
  // content is not duplicated.
  //
  // Expected: FAIL until fix. The unsynced-changes path has no content-level
  // defense today.
  test('REPRO: unsynced local changes during restart preserve edit and avoid duplication', async () => {
    let server = await createRestartableServer();
    cleanups.push(() => server.shutdown());

    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());
    await seedPoolServerInstanceId(server, pool);

    const firstProvider = await seedAndSyncSingleClient(server, pool, 'test-doc');

    // Make a local WYSIWYG-style edit to bump unsyncedChanges.
    // Use the fragment directly so the edit is a real Y.js mutation (producing
    // an Item under the client's clientID).
    const UNIQUE_LOCAL_MARKER = 'T4-LOCAL-EDIT-MARKER-9f3a';
    const doc = firstProvider.document;
    const Y = await import('yjs');
    const paragraph = new Y.XmlElement('paragraph');
    const ytext = new Y.XmlText();
    ytext.applyDelta([{ insert: UNIQUE_LOCAL_MARKER }]);
    paragraph.insert(0, [ytext]);
    doc.getXmlFragment('default').push([paragraph]);

    // Wait for the edit to reach the server's in-memory Y.Doc by polling
    // `unsyncedChanges === 0` (deterministic — does not depend on wall-clock
    // timing, so slow CI runners behave identically to local loopback). We
    // kill the network before the L1 persistence debounce (200ms) flushes to
    // markdown so the fresh server starts without this edit on disk — the
    // client-side buffer-and-replay path is what carries it across the recycle.
    // Poll interval is 10ms; on loopback the ack lands in 1-5ms, so we exit
    // this wait well before the 200ms L1 threshold.
    await pollUntil(() => firstProvider.unsyncedChanges === 0, 180, 10);
    server.killNetwork();
    // Small wait so the client's websocket observes the disconnect.
    await wait(100);

    // Precondition: disconnect was observed.
    expect(pool.getActive()?.syncState).toBe('disconnected');

    // Restart on same port, fast window.
    server = await server.killAndRestartOnSamePort({ downtimeMs: 400 });
    cleanups.unshift(() => server.shutdown());

    // Wait for re-sync.
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);

    // Behavior: client-side buffer-and-replay captures the unsynced delta
    // before clearData + recycle, then replays it onto the fresh provider's
    // first sync. The local edit survives in the client's Y.Doc and lands
    // back on the server on the next L1 flush.

    // The local edit survives in the client's Y.Doc.
    await pollUntil(
      () =>
        pool
          .getActive()
          ?.provider.document.getText('source')
          .toString()
          .includes(UNIQUE_LOCAL_MARKER) ?? false,
      5000,
      50,
    );

    // Behavior: disk content matches baseline + exactly one copy of the local
    // marker (no duplication).
    const afterRestart = await pollDiskContentStable(
      join(server.contentDir, 'test-doc.md'),
      (c) => c.includes(UNIQUE_LOCAL_MARKER),
      { timeoutMs: 8000, settleMs: 400 },
    );
    const afterHeadings = (afterRestart.match(/# Test Document/g) ?? []).length;
    const afterTestDocLinks = (afterRestart.match(/\[\[test-doc\]\]/g) ?? []).length;
    const afterLocalMarker = (afterRestart.match(new RegExp(UNIQUE_LOCAL_MARKER, 'g')) ?? [])
      .length;

    console.log('[T4] counts', {
      afterHeadings,
      afterTestDocLinks,
      afterLocalMarker,
      diskBytes: afterRestart.length,
    });

    expect(afterHeadings).toBe(2);
    expect(afterTestDocLinks).toBe(1);
    expect(afterLocalMarker).toBe(1);
  }, 30_000);
});
