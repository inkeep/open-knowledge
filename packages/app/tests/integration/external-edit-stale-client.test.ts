/**
 * External disk edit during fast server restart.
 *
 * Flow:
 *   1. Server starts with content-A on disk. Client connects, syncs.
 *   2. `server.killNetwork()` — HTTP/WS torn down but client keeps Y.Doc
 *      with content-A under its original clientID.
 *   3. While the server is offline, content on disk is OVERWRITTEN to
 *      content-B (simulating the user editing the file in another editor
 *      or a git pull landing new content).
 *   4. Fast restart on same port. New server's `persistence.onLoadDocument`
 *      loads content-B from disk under a fresh server clientID.
 *   5. Client reconnects within the 4s recycle window. Yjs sync merges:
 *      client's content-A Items + server's content-B Items.
 *
 * Bug class: post-merge, the client's Y.Doc contains BOTH content-A and
 * content-B — a mix, not a replace. Worse than T1 (which just doubles the
 * same content); here, stale content is re-introduced into a doc that
 * should have the new content.
 *
 * Expected: PASS post-fix. Regression guard for the pre- bug class
 * — pre-fix, the merged state retained content-A markers; post-fix only
 * content-B is present. Any reintroduction of the stale-client merge path
 * trips this red.
 */
import './idb-preload';
import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { ProviderPool } from '../../src/editor/provider-pool';
import {
  clientIdsInDoc,
  createRestartableServer,
  pollDiskContentStable,
  pollUntil,
  seedPoolServerInstanceId,
} from './test-harness';

const CONTENT_A = `# Version A

Content A only.

[[a-only-sibling]]
`;

const CONTENT_B = `# Version B

Content B only.

[[b-only-sibling]]
`;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
}, 30_000);

describe('T9: External disk edit during server restart', () => {
  test('REPRO: disk flipped from A to B during downtime, tab open — no content-A bleed', async () => {
    let server = await createRestartableServer();
    cleanups.push(() => server.shutdown());

    // Seed content-A before client connects.
    writeFileSync(join(server.contentDir, 'test-doc.md'), CONTENT_A, 'utf-8');

    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());
    await seedPoolServerInstanceId(server, pool);

    pool.open('test-doc');
    pool.setActive('test-doc');
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 10_000, 50);
    await wait(150);

    const firstProvider = pool.getActive()?.provider;
    if (!firstProvider) throw new Error('no provider post-sync');

    // Confirm client sees content-A.
    const preText = firstProvider.document.getText('source').toString();
    expect(preText.includes('a-only-sibling')).toBe(true);

    const preClientIds = clientIdsInDoc(firstProvider.document);

    // Capture server contentDir before killing — it survives the restart.
    const contentDir = server.contentDir;

    // Kill network; do NOT destroy the whole server — killAndRestartOnSamePort
    // will do that. But we need to write to disk DURING the downtime window.
    // We'll do it after the kill but before the restart call, using a manual
    // downtime loop instead of the combined helper.
    server.killNetwork();

    // Wait for client to observe disconnect.
    await pollUntil(() => pool.getActive()?.syncState === 'disconnected', 3000, 50);

    // Overwrite disk with content-B while server is offline.
    writeFileSync(join(contentDir, 'test-doc.md'), CONTENT_B, 'utf-8');
    // Small pause to ensure the write hits fsync before the new server starts
    // its file watcher.
    await wait(200);

    // Restart on same port, fast window.
    server = await server.killAndRestartOnSamePort({ downtimeMs: 300 });
    cleanups.unshift(() => server.shutdown());

    // Client reconnects + re-syncs. the fast-restart path kept
    // the same provider; post-fix the authenticationFailed recycle fires
    // and the active provider is fresh. Read the post-restart provider
    // from the pool rather than the captured `firstProvider` reference.
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);

    await wait(500);

    const activeEntry = pool.getActive();
    if (!activeEntry) throw new Error('pool has no active entry post-restart');
    const activeProvider = activeEntry.provider;
    const postClientIds = clientIdsInDoc(activeProvider.document);
    const grewBy = postClientIds.size - preClientIds.size;

    const postText = activeProvider.document.getText('source').toString();
    const aSiblings = (postText.match(/\[\[a-only-sibling\]\]/g) ?? []).length;
    const bSiblings = (postText.match(/\[\[b-only-sibling\]\]/g) ?? []).length;
    const aHeading = (postText.match(/# Version A/g) ?? []).length;
    const bHeading = (postText.match(/# Version B/g) ?? []).length;

    console.log('[T9] marker counts', {
      aSiblings,
      bSiblings,
      aHeading,
      bHeading,
      grewBy,
      clientIdSetSize: postClientIds.size,
    });

    // Behavior: content-B present exactly once; content-A fully gone.
    expect(bSiblings).toBe(1);
    expect(bHeading).toBe(1);
    expect(aSiblings).toBe(0);
    expect(aHeading).toBe(0);

    // Disk reflects content-B.
    const diskAfter = await pollDiskContentStable(
      join(contentDir, 'test-doc.md'),
      (c) => c.includes('b-only-sibling'),
      { timeoutMs: 5000, settleMs: 300 },
    );
    expect((diskAfter.match(/b-only-sibling/g) ?? []).length).toBe(1);
    expect((diskAfter.match(/a-only-sibling/g) ?? []).length).toBe(0);
  }, 30_000);
});
