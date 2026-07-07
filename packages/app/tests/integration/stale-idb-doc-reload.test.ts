/**
 * Doc-lineage consistency for client-persisted state, same server instance.
 *
 * Invariant under test: client-persisted Y.Doc state must only ever rejoin
 * the Yjs lineage it was persisted from. The server mints a fresh lineage
 * whenever a doc is loaded (persistence onLoadDocument seeds from file
 * bytes), while the client's IndexedDB cache is keyed per server INSTANCE —
 * so a doc that the server unloaded and later re-seeded from disk presents a
 * brand-new lineage to a client that still holds the old one. Syncing the
 * two union-merges independent materializations: previously-synced content
 * appears twice, and content that no longer exists on disk resurrects.
 *
 * The restart-axis suite (provider-pool-reconnect, c10-server-restart,
 * populated-idb-stale-server, cold-start-empty-idb) covers lineage re-mints
 * caused by a NEW server instance, where the instance-mismatch recovery
 * clears the stale cache. This file covers the same-instance axis: the doc's
 * lineage churns without the instance changing, so no existing recovery
 * fires.
 *
 * The persistence tripwire (`persistence-tripwire.ts`) blocks only the
 * degenerate shape of this merge — a candidate that is an exact integer
 * multiple of the base body, which is what a same-bytes recreate produces.
 * The general case staged here, where the file content drifted between
 * sessions (git pull / checkout rewrites a file as delete + recreate), is
 * not an integer multiple and sails through to disk.
 *
 * Scenario (every move is a production surface):
 *   1. Tab opens a doc, syncs, IndexedDB mirrors it (session 1).
 *   2. Tab navigates away — pool entry closed, IDB data intentionally kept.
 *   3. An external tool deletes and recreates the file with updated content.
 *      The watcher delete path force-unloads the server-side doc; the
 *      recreate is re-seeded from disk on next load as a fresh lineage.
 *   4. The same tab reopens the doc (session 2).
 *
 * Contract: after session 2 syncs, the client, the server, and disk all hold
 * exactly the new file content — shared content exactly once, no
 * resurrection of stale content. How the seam achieves that — server-side
 * lineage stability, a lineage signal the client checks before hydrating, or
 * any other shape — is deliberately not pinned here.
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
 * having raced the IDB flush.
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

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe('client-persisted state meets a re-seeded doc lineage (same server instance)', () => {
  test('reopening a doc the server unloaded and re-seeded from disk shows the disk content exactly once', async () => {
    const server = await createTestServer();
    cleanups.push(() => server.cleanup());

    const docName = `lineage-${crypto.randomUUID()}`;
    const filePath = join(server.contentDir, `${docName}.md`);
    writeFileSync(filePath, FIXTURE_V1, 'utf-8');
    await awaitFileWatcherIndexed(server, docName);

    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());
    const serverInstanceId = await seedPoolServerInstanceId(server, pool);

    // Session 1: open + sync. The pool attaches IndexedDB persistence at
    // admission time (instance id already known) and mirrors the doc.
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

    // Tab navigates away. close() destroys provider + persistence handle but
    // keeps the IDB data — that durability is the feature under test.
    pool.close(docName);

    // External rewrite: delete + recreate with updated content (git pull /
    // checkout, unlink-then-write editor saves). The watcher delete path
    // force-unloads the loaded doc; the recreate stays unloaded until the
    // next connection re-seeds it from disk.
    rmSync(filePath);
    await pollUntil(() => getServerState(server, docName) === null, 20_000, 100);
    writeFileSync(filePath, FIXTURE_V2, 'utf-8');
    await awaitFileWatcherIndexed(server, docName);

    // Session 2: the same tab reopens the doc. The client hydrates its
    // persisted state and syncs with the freshly re-seeded server doc.
    pool.open(docName);
    pool.setActive(docName);
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 15_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 15_000, 50);
    // Brief settle so the server's observer dispatch on the incoming remote
    // update has broadcast its outcome back to the client.
    await wait(500);

    const clientYtext = (): string =>
      pool.getActive()?.provider.document.getText('source').toString() ?? '';
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
