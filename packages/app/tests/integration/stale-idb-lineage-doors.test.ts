/**
 * Doc-lineage consistency for client-persisted state — two further doors
 * into the union-merge corruption that `stale-idb-doc-reload.test.ts`
 * pins for the basic same-pool reopen.
 *
 * Invariant under test (same as the sibling file): client-persisted
 * Y.Doc state must only ever rejoin the Yjs lineage it was persisted
 * from. The server mints a fresh lineage whenever it re-seeds a doc
 * from disk (unload + reload), while the client's IndexedDB cache for
 * the doc survives, keyed only by (branch, server instance, docName) —
 * so stale state can meet a fresh lineage of the same doc, and Yjs
 * union-merges the two independent materializations: shared content
 * doubles, removed content resurrects.
 *
 * Door 1 — deferred persistence attach. A pool that does not yet know
 * the server instance id cannot attach IDB persistence at open() time
 * (the DB name carries the id), so the provider syncs over WS first and
 * persistence attaches retroactively when the id lands
 * (`setExpectedServerInstanceId` → deferred attach). When the IDB rows
 * predate a lineage re-mint, that late attach hydrates stale state into
 * an ALREADY-SYNCED live doc. The instance-unknown window is a standing
 * production state: every page load opens docs before the server-info
 * fetch lands, and mismatch recovery re-enters it mid-session by
 * clearing the cached id.
 *
 * Door 2 — fresh-pool rejoin. Session 1 happens in tab A; tab A closes
 * (pool disposed — its IDB data intentionally survives; that cache is
 * the warm-reload feature). The file is deleted and recreated with
 * drifted content while no tab is open — the watcher delete path
 * unloads the server-side doc, and the next load re-seeds a fresh
 * lineage from disk. Tab B — a brand-new pool over the same IndexedDB
 * and localStorage substrate — reopens the doc and hydrates tab A's
 * stale rows into the fresh lineage. This is the everyday close-tab →
 * git pull → reopen sequence.
 *
 * Contract (identical to the sibling file, asserted per door): after
 * the rejoin settles, the client, the server, and disk all hold exactly
 * the current disk content — shared content exactly once, no
 * resurrection of removed content. How the seam achieves that — and how
 * either door gets fenced — is deliberately not pinned.
 */
import './idb-preload';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Y from 'yjs';
import {
  createClientPersistence,
  UNKNOWN_BRANCH_SENTINEL,
} from '../../src/editor/client-persistence';
import { ProviderPool } from '../../src/editor/provider-pool';
import {
  awaitFileWatcherIndexed,
  createTestServer,
  getServerState,
  pollUntil,
  seedPoolServerInstanceId,
  wait,
} from './test-harness';

const FIXTURE_V1 = `# Lineage Fixture

Stable paragraph: shared marker LINEAGE-ALPHA.

## Session One Section

Paragraph with marker LINEAGE-V1-ONLY that the rewrite removes.
`;

const FIXTURE_V2 = `# Lineage Fixture

Stable paragraph: shared marker LINEAGE-ALPHA.

## Session Two Section

Paragraph with marker LINEAGE-V2-ONLY introduced by the rewrite.
`;

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Read the ytext persisted client-side for (branch, instanceId, docName)
 * through the production persistence factory. Stages nothing — used only to
 * confirm the precondition "session 1 left durable client-persisted state
 * behind" before the doc is unloaded, so the test cannot go green by simply
 * having raced the IDB flush. Same probe as the sibling file.
 */
async function readPersistedYtext(docName: string, serverInstanceId: string): Promise<string> {
  const doc = new Y.Doc();
  const persistence = createClientPersistence({
    branch: UNKNOWN_BRANCH_SENTINEL,
    serverInstanceId,
    docName,
    doc,
  });
  try {
    await persistence.whenSynced;
    return doc.getText('source').toString();
  } finally {
    await persistence.destroy();
    doc.destroy();
  }
}

/**
 * Map-backed localStorage stub — the pool constructor's `storage` seam,
 * same shape as `provider-pool.test.ts`. Sharing ONE stub between two
 * pools models same-origin localStorage as seen by two successive tabs.
 */
function makeStubStorage(): {
  stub: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  const stub = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
  return { stub, store };
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe('client-persisted state meets a re-seeded doc lineage (deferred-attach door)', () => {
  test('an instance id learned after sync must not hydrate a stale lineage into the live doc', async () => {
    const server = await createTestServer();
    cleanups.push(() => server.cleanup());

    const docName = `lineage-deferred-${crypto.randomUUID()}`;
    const filePath = join(server.contentDir, `${docName}.md`);
    writeFileSync(filePath, FIXTURE_V1, 'utf-8');
    await awaitFileWatcherIndexed(server, docName);

    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`, {
      storage: makeStubStorage().stub,
    });
    cleanups.push(() => pool.dispose());
    const serverInstanceId = await seedPoolServerInstanceId(server, pool);

    // Session 1: instance id known → persistence attaches at admission
    // time and IndexedDB mirrors the doc.
    pool.open(docName);
    pool.setActive(docName);
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 15_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 15_000, 50);
    const session1Text = pool.getActive()?.provider.document.getText('source').toString() ?? '';
    expect(countOccurrences(session1Text, 'LINEAGE-ALPHA')).toBe(1);
    expect(countOccurrences(session1Text, 'LINEAGE-V1-ONLY')).toBe(1);

    // Precondition gate: the client-side persistence durably holds session
    // 1's state before we retire the entry.
    await pollUntil(
      async () =>
        countOccurrences(await readPersistedYtext(docName, serverInstanceId), 'LINEAGE-V1-ONLY') >
        0,
      10_000,
      100,
    );

    // Tab navigates away — entry closed, IDB data intentionally kept.
    pool.close(docName);

    // External rewrite: delete + recreate with drifted content. The watcher
    // delete path force-unloads the loaded doc; the recreate stays unloaded
    // until the next connection re-seeds it from disk as a fresh lineage.
    rmSync(filePath);
    await pollUntil(() => getServerState(server, docName) === null, 20_000, 100);
    writeFileSync(filePath, FIXTURE_V2, 'utf-8');
    await awaitFileWatcherIndexed(server, docName);

    // The pool drops back into the instance-unknown window — the standing
    // state of every cold boot before the server-info fetch lands, and the
    // state mismatch recovery re-enters mid-session (see
    // setExpectedServerInstanceId's contract on null).
    pool.setExpectedServerInstanceId(null);

    // Session 2: reopen during the unknown-instance window. Admission-time
    // persistence attach is skipped; the provider connects and fully syncs
    // the freshly re-seeded doc over WS.
    pool.open(docName);
    pool.setActive(docName);
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 15_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 15_000, 50);

    const clientYtext = (): string =>
      pool.getActive()?.provider.document.getText('source').toString() ?? '';
    const serverYtext = (): string => getServerState(server, docName)?.ytext.toString() ?? '';

    // Pre-attach sanity: the reopened doc holds exactly the fresh lineage —
    // whatever happens next can only come from the late persistence attach.
    const preAttachText = clientYtext();
    expect(countOccurrences(preAttachText, 'LINEAGE-ALPHA')).toBe(1);
    expect(countOccurrences(preAttachText, 'LINEAGE-V1-ONLY')).toBe(0);
    expect(countOccurrences(preAttachText, 'LINEAGE-V2-ONLY')).toBe(1);

    // The server-info fetch lands: the pool learns the instance id and
    // retroactively attaches persistence to the already-synced entry.
    await seedPoolServerInstanceId(server, pool);

    // Quiescence: persistence attached and hydrated, sync settled. The
    // hydrate-complete gate (whenSynced) is what makes the staging
    // deterministic — without it the assertions could race the IDB read.
    await pollUntil(() => (pool.getActive()?.persistence ?? null) !== null, 15_000, 50);
    await pool.getActive()?.persistence?.whenSynced;
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 15_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 15_000, 50);
    // Brief settle so the server's observer dispatch on any incoming remote
    // update has broadcast its outcome back to the client.
    await wait(500);

    // THE CONTRACT: the client shows the current disk content exactly once —
    // shared content not duplicated, removed content not resurrected.
    const clientText = clientYtext();
    expect(countOccurrences(clientText, 'LINEAGE-ALPHA')).toBe(1);
    expect(countOccurrences(clientText, 'LINEAGE-V1-ONLY')).toBe(0);
    expect(countOccurrences(clientText, 'LINEAGE-V2-ONLY')).toBe(1);

    // Client and server converge on that same single-copy text.
    await pollUntil(() => clientYtext().length > 0 && clientYtext() === serverYtext(), 10_000, 100);
    expect(clientYtext()).toBe(FIXTURE_V2);
    expect(countOccurrences(serverYtext(), 'LINEAGE-ALPHA')).toBe(1);

    // The corruption must not reach disk either. "Nothing was written" has
    // no event to wait on, so wait out the persistence debounce horizon
    // (debounce 200ms, maxDebounce 1000ms in the harness) before reading.
    await wait(1500);
    const diskContent = readFileSync(filePath, 'utf-8');
    expect(countOccurrences(diskContent, 'LINEAGE-ALPHA')).toBe(1);
    expect(countOccurrences(diskContent, 'LINEAGE-V1-ONLY')).toBe(0);
    expect(countOccurrences(diskContent, 'LINEAGE-V2-ONLY')).toBe(1);
  }, 120_000);
});

describe('client-persisted state meets a re-seeded doc lineage (fresh-pool rejoin door)', () => {
  test('a brand-new pool reopening a doc the server unloaded and re-seeded shows the disk content exactly once', async () => {
    const server = await createTestServer();
    cleanups.push(() => server.cleanup());

    const docName = `lineage-freshpool-${crypto.randomUUID()}`;
    const filePath = join(server.contentDir, `${docName}.md`);
    writeFileSync(filePath, FIXTURE_V1, 'utf-8');
    await awaitFileWatcherIndexed(server, docName);

    const wsUrl = `ws://127.0.0.1:${server.port}/collab`;
    // One storage substrate shared by both pools — same-origin localStorage
    // as two successive tabs see it. The fake-IDB substrate (idb-preload)
    // is process-global, so it is shared by construction.
    const { stub: sharedStorage } = makeStubStorage();

    // Session 1 — tab A.
    const poolA = new ProviderPool(3, wsUrl, { storage: sharedStorage });
    cleanups.push(() => poolA.dispose());
    const serverInstanceId = await seedPoolServerInstanceId(server, poolA);
    poolA.open(docName);
    poolA.setActive(docName);
    await pollUntil(() => poolA.getActive()?.provider.isSynced === true, 15_000, 50);
    await pollUntil(() => poolA.getActive()?.provider.unsyncedChanges === 0, 15_000, 50);
    const session1Text = poolA.getActive()?.provider.document.getText('source').toString() ?? '';
    expect(countOccurrences(session1Text, 'LINEAGE-ALPHA')).toBe(1);
    expect(countOccurrences(session1Text, 'LINEAGE-V1-ONLY')).toBe(1);

    // Precondition gate: durable client-persisted state exists before the
    // tab closes.
    await pollUntil(
      async () =>
        countOccurrences(await readPersistedYtext(docName, serverInstanceId), 'LINEAGE-V1-ONLY') >
        0,
      10_000,
      100,
    );

    // Tab A closes entirely. dispose() destroys providers and persistence
    // HANDLES; the IDB data survives — a closed tab leaves its cache
    // behind. That durability is the feature under test.
    poolA.dispose();

    // External rewrite while no tab is open: delete + recreate with drifted
    // content. The watcher delete path force-unloads the loaded doc; the
    // recreate stays unloaded until the next connection re-seeds it.
    rmSync(filePath);
    await pollUntil(() => getServerState(server, docName) === null, 20_000, 100);
    writeFileSync(filePath, FIXTURE_V2, 'utf-8');
    await awaitFileWatcherIndexed(server, docName);

    // Session 2 — tab B: a brand-new pool over the same IDB + localStorage
    // substrate. Boot order mirrors production: server-info first (instance
    // id known), then the user navigates to the doc.
    const poolB = new ProviderPool(3, wsUrl, { storage: sharedStorage });
    cleanups.push(() => poolB.dispose());
    await seedPoolServerInstanceId(server, poolB);
    poolB.open(docName);
    poolB.setActive(docName);
    await pollUntil(() => poolB.getActive()?.provider.isSynced === true, 15_000, 50);
    await pollUntil(() => poolB.getActive()?.provider.unsyncedChanges === 0, 15_000, 50);
    // Brief settle so the server's observer dispatch on the incoming remote
    // update has broadcast its outcome back to the client.
    await wait(500);

    const clientYtext = (): string =>
      poolB.getActive()?.provider.document.getText('source').toString() ?? '';
    const serverYtext = (): string => getServerState(server, docName)?.ytext.toString() ?? '';

    // THE CONTRACT: the client shows the current disk content exactly once —
    // shared content not duplicated, removed content not resurrected.
    const clientText = clientYtext();
    expect(countOccurrences(clientText, 'LINEAGE-ALPHA')).toBe(1);
    expect(countOccurrences(clientText, 'LINEAGE-V1-ONLY')).toBe(0);
    expect(countOccurrences(clientText, 'LINEAGE-V2-ONLY')).toBe(1);

    // Client and server converge on that same single-copy text.
    await pollUntil(() => clientYtext().length > 0 && clientYtext() === serverYtext(), 10_000, 100);
    expect(clientYtext()).toBe(FIXTURE_V2);
    expect(countOccurrences(serverYtext(), 'LINEAGE-ALPHA')).toBe(1);

    // The corruption must not reach disk either. "Nothing was written" has
    // no event to wait on, so wait out the persistence debounce horizon
    // (debounce 200ms, maxDebounce 1000ms in the harness) before reading.
    await wait(1500);
    const diskContent = readFileSync(filePath, 'utf-8');
    expect(countOccurrences(diskContent, 'LINEAGE-ALPHA')).toBe(1);
    expect(countOccurrences(diskContent, 'LINEAGE-V1-ONLY')).toBe(0);
    expect(countOccurrences(diskContent, 'LINEAGE-V2-ONLY')).toBe(1);
  }, 120_000);
});
