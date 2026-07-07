/**
 * T14 — Populated IDB meets a fresh server with a DIFFERENT serverInstanceId.
 *
 * Scenario: a browser tab had persisted content to IDB (`ok-ydoc:test-doc`)
 * during a prior session with server instance A. The user returns, but
 * server has been restarted and is now on instance B. The pool's auth token
 * claims A (cached from last session); server rejects with
 * `server-instance-mismatch`.
 *
 * Expected behavior:
 *   1. On first connect, server's `onAuthenticate` throws
 *      `reason: 'server-instance-mismatch'`.
 *   2. Client's `authenticationFailed` handler fires
 *      `handleServerInstanceMismatch()` → `clearData` wipes the stale IDB,
 *      then `recycleAllEntries()` destroys and re-opens every provider with
 *      a null auth claim.
 *   3. Fresh provider syncs cleanly with the current (instance-B) server;
 *      the client's final Y.Doc reflects the server's markdown-rebuilt
 *      state, with no duplication or stale-content bleed.
 *   4. IDB is empty post-recycle (wiped by `clearData`) — or, on the fresh
 *      open, newly populated with only the current server's state.
 *
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import * as Y from 'yjs';
import { ProviderPool } from '../../src/editor/provider-pool';
import { createRestartableServer, pollUntil, seedClientPersistenceState } from './test-harness';

const CURRENT_SERVER_MARKDOWN = `# Current Server Doc

Paragraph with unique marker T14-CURRENT.

[[current-sibling]]
`;

const STALE_MARKER = 'T14-STALE-FROM-PRIOR-SESSION';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe('T14: populated IDB meets stale server instance', () => {
  test('stale IDB + wrong serverInstanceId: authenticationFailed clears IDB, fresh sync has no stale bleed', async () => {
    // 1. Boot the server and seed its markdown content.
    const server = await createRestartableServer();
    cleanups.push(() => server.shutdown());
    writeFileSync(join(server.contentDir, 'test-doc.md'), CURRENT_SERVER_MARKDOWN, 'utf-8');
    await wait(250);

    // 2. Pre-populate IDB with stale content — simulating "tab had an
    //    earlier session against a previous server instance that crashed."
    //    Construct the update bytes off a throwaway Y.Doc so we pass Yjs-
    //    valid bytes to `seedClientPersistenceState`. The DB-name epoch
    //    here is the CRASHED prior session's id, not the current one.
    const STALE_INSTANCE_ID = 't14-stale-instance-id-mismatch-xyz';
    const seedDoc = new Y.Doc();
    seedDoc.getText('source').insert(0, STALE_MARKER);
    const staleBytes = Y.encodeStateAsUpdate(seedDoc);
    seedDoc.destroy();

    await seedClientPersistenceState('test-doc', [staleBytes], STALE_INSTANCE_ID);

    // 3. Construct the pool with a WRONG serverInstanceId claim. The pool
    //    will include this in its auth token and the server's
    //    `onAuthenticate` will reject. NOT calling
    //    `seedPoolServerInstanceId` — that would fetch and cache the
    //    CURRENT server's id, which is exactly what we're trying to avoid.
    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());
    pool.setExpectedServerInstanceId(STALE_INSTANCE_ID);

    pool.open('test-doc');
    pool.setActive('test-doc');

    // 4. Wait for the mismatch recycle to complete + the fresh provider's
    //    re-sync. `cachedServerInstanceId` gets nulled after
    //    `handleServerInstanceMismatch`, so the recycled provider's token
    //    drops the claim — the server accepts this time.
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 15_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 15_000, 50);

    // Brief settle for observer bridge + any buffered replay path.
    await wait(300);

    // 5. Final state: server's markdown content is present, and the stale
    //    content from IDB does NOT leak through. Test the WHAT (no stale
    //    bleed) rather than the HOW (which specific code path filtered it).
    const entry = pool.getActive();
    if (!entry) throw new Error('pool has no active entry after mismatch-recycle');
    const clientText = entry.provider.document.getText('source').toString();

    expect((clientText.match(/T14-CURRENT/g) ?? []).length).toBe(1);
    expect((clientText.match(/\[\[current-sibling\]\]/g) ?? []).length).toBe(1);
    expect((clientText.match(new RegExp(STALE_MARKER, 'g')) ?? []).length).toBe(0);
  }, 30_000);
});
