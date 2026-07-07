/**
 * Cold start with empty IDB syncs cleanly from a just-restarted server.
 *
 * Scenario: the browser tab had never opened this doc before (IDB empty for
 * `ok-ydoc:test-doc`) AND the server has already restarted at least once
 * (new serverInstanceId). This is the common "user opens OpenKnowledge for
 * the first time after a server restart" path — nothing pre-existing on the
 * client, fresh server identity.
 *
 * Assertions:
 *   1. Before first open, IDB for the target doc is empty.
 *   2. The pool constructs its auth token with the POST-restart
 *      serverInstanceId (seeded via `seedPoolServerInstanceId`) — no
 *      `authenticationFailed` fires, because the claim matches.
 *   3. After sync, the client's Y.Text matches the markdown-rebuilt server
 *      state — each content marker appears exactly once (no duplication).
 *   4. Disk content is stable and still matches the seeded markdown.
 *
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { ProviderPool } from '../../src/editor/provider-pool';
import {
  assertIDBEmpty,
  createRestartableServer,
  pollDiskContentStable,
  pollUntil,
  seedPoolServerInstanceId,
} from './test-harness';

const COLD_START_FIXTURE = `# Cold Start Doc

Paragraph A: unique marker T13-ALPHA.

Paragraph B: unique marker T13-BRAVO.

[[cold-sibling]]
`;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe('T13: cold start with empty IDB after server restart', () => {
  test('empty IDB + restarted server: syncs cleanly, no duplication', async () => {
    // 1. Seed markdown on disk, boot the server so it picks up the content,
    //    then restart on the same port so the surviving `serverInstanceId`
    //    is NOT the same as the one a hypothetical prior client session
    //    would have cached. Simulates the "server restarted while this tab
    //    was never open" shape.
    let server = await createRestartableServer();
    cleanups.push(() => server.shutdown());
    writeFileSync(join(server.contentDir, 'test-doc.md'), COLD_START_FIXTURE, 'utf-8');

    // Let the file watcher index the doc before the restart so the
    // post-restart server reloads from disk rather than racing the watcher.
    await wait(250);

    server = await server.killAndRestartOnSamePort({ downtimeMs: 400 });
    cleanups.unshift(() => server.shutdown());

    // 3. Construct a fresh pool and seed its serverInstanceId from the
    //    POST-restart server. Mirrors the browser's DocumentContext boot
    //    flow: `/api/server-info` → `pool.setExpectedServerInstanceId(id)`.
    //    The claim will match, so no `authenticationFailed` should fire.
    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());
    const serverInstanceId = await seedPoolServerInstanceId(server, pool);

    // 2. Precondition: IDB is empty under the post-restart epoch's DB
    //    name — no prior client session ever wrote to that name. The
    //    epoch-scoped DB shape is `ok-ydoc:${branch}:${serverInstanceId}:${docName}`,
    //    so the post-restart epoch's slot is fresh by construction.
    await assertIDBEmpty('test-doc', serverInstanceId);

    pool.open('test-doc');
    pool.setActive('test-doc');

    // 4. Wait for first sync + ack round-trip.
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 10_000, 50);

    // Brief settle for the observer bridge to run Path A (XmlFragment → Y.Text).
    await wait(200);

    // 5. Behavior: each content marker appears exactly once on the client.
    const entry = pool.getActive();
    if (!entry) throw new Error('pool has no active entry after sync');
    const clientText = entry.provider.document.getText('source').toString();

    expect((clientText.match(/T13-ALPHA/g) ?? []).length).toBe(1);
    expect((clientText.match(/T13-BRAVO/g) ?? []).length).toBe(1);
    expect((clientText.match(/\[\[cold-sibling\]\]/g) ?? []).length).toBe(1);
    expect((clientText.match(/# Cold Start Doc/g) ?? []).length).toBe(1);

    // 6. Disk content still matches baseline — no re-serialization mangled it.
    const diskAfter = await pollDiskContentStable(
      join(server.contentDir, 'test-doc.md'),
      (c) => c.includes('T13-ALPHA') && c.includes('T13-BRAVO'),
      { timeoutMs: 5000, settleMs: 300 },
    );
    expect((diskAfter.match(/T13-ALPHA/g) ?? []).length).toBe(1);
    expect((diskAfter.match(/T13-BRAVO/g) ?? []).length).toBe(1);

    // 7. Mechanism confirmation: the disk file is still the fixture (the
    //    markdown-rebuild path was the only source of server Y.Doc content —
    //    there was no sidecar to load from).
    const onDisk = readFileSync(join(server.contentDir, 'test-doc.md'), 'utf-8');
    expect(onDisk).toContain('Paragraph A: unique marker T13-ALPHA.');
    expect(onDisk).toContain('Paragraph B: unique marker T13-BRAVO.');
  }, 30_000);
});
