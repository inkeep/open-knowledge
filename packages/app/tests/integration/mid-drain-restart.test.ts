/**
 * Mid-drain server restart.
 *
 * The persistence module has two debounce layers:
 *   L1: Hocuspocus's onStoreDocument debounce (default 2000ms; tests 200ms)
 *       — flushes Y.Doc markdown to disk.
 *   L2: Shadow-repo commit debounce (`commitDebounceMs`, default 15s; tests
 *       use a short override) — after L1 disk write lands, buildWipTree +
 *       commitWipFromTree is scheduled. The contributor snapshot is drained
 *       atomically at the start of L2.
 *
 * If the server process dies BETWEEN `swapContributors()` and successful
 * `commitWipFromTree` completion, the snapshot is lost.
 * This is attribution-loss, NOT content-loss — the markdown was already on
 * disk before the drain cycle started.
 *
 * This test codifies the accepted failure mode: content survives; attribution
 * for the crashed drain cycle is forfeit. Any future change that upgrades
 * this to content-loss must flip this test RED.
 *
 * Expected: PASS. Content durable on disk; client Y.Doc reflects content
 * once after reconnect.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { ProviderPool } from '../../src/editor/provider-pool';
import {
  agentWriteMd,
  attachSystemDocSubscriber,
  createRestartableServer,
  pollDiskContentStable,
  pollUntil,
  seedPoolServerInstanceId,
} from './test-harness';

const DURABILITY_MARKER = 'T11-DURABILITY-MARKER-7a3f';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe('T11: Mid-drain server restart', () => {
  test('content written shortly before crash survives restart; attribution may be forfeit', async () => {
    // Short L1 debounce so the markdown lands on disk fast; gitEnabled true so
    // the L2 drain has work to do; short commitDebounce so we can provoke a
    // mid-drain scenario within the test budget.
    let server = await createRestartableServer({
      gitEnabled: true,
      commitDebounceMs: 2000, // L2 drain scheduled 2s after L1 disk write
      debounce: 100, // L1 flush fast
      maxDebounce: 300,
    });
    cleanups.push(() => server.shutdown());

    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());

    // Mirror production's boot sequence:
    // 1. Fetch `/api/server-info` and seed the pool's
    //    `cachedServerInstanceId` BEFORE any provider opens. The provider's
    //    auth token snapshots this at construction; without it, the
    //    post-restart reconnect carries no claim and the server accepts
    //    legacy-style — no mismatch fires, no recycle, marker duplicates.
    // 2. Attach the CC1 system-doc subscriber so the pool receives
    //    `disk-ack` frames on every L1 flush. Without this the
    //    `lastDiskAckedSV` watermark stays null and the mismatch-recycle
    //    baseline falls back to `lastServerSyncedSV` — which is past the
    //    marker, so the recycle buffer replays the marker on top of the
    //    post-restart server's rebuilt-from-disk Y.Doc, producing
    //    2-3x marker duplication. With disk-ack wired, baseline =
    //    lastDiskAckedSV (also past the marker, but disk-ack means the
    //    server's markdown rebuild ALREADY includes it on restart) →
    //    recycle buffer is empty → marker appears exactly once.
    await seedPoolServerInstanceId(server, pool);
    const systemSub = attachSystemDocSubscriber(pool, server.port);
    cleanups.push(() => systemSub.dispose());

    pool.open('test-doc');
    pool.setActive('test-doc');
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);

    // Agent write — content + marker appears on disk when L1 flushes. L2
    // commit fires ~2s later.
    await agentWriteMd(server.port, `\n\n${DURABILITY_MARKER}\n`, {
      docName: 'test-doc',
      position: 'append',
      agentId: 't11-agent',
      agentName: 'T11-Agent',
    });

    // Wait for L1 disk flush.
    await pollDiskContentStable(
      join(server.contentDir, 'test-doc.md'),
      (c) => c.includes(DURABILITY_MARKER),
      { timeoutMs: 5000, settleMs: 200 },
    );

    // Sanity: marker IS on disk right now.
    const contentDir = server.contentDir;
    const preRestartDisk = readFileSync(join(contentDir, 'test-doc.md'), 'utf-8');
    expect(preRestartDisk.includes(DURABILITY_MARKER)).toBe(true);

    // Wait 500ms — L2 drain is scheduled at T+2000ms relative to L1 flush,
    // so we're inside the drain debounce window but BEFORE it fires. Then
    // killAndRestart with 300ms downtime = total ~800ms since L1, well under
    // 2000ms L2 debounce. If we kill here, the git commit for this drain
    // is definitionally lost (was never scheduled before the fresh restart).
    await wait(500);
    server = await server.killAndRestartOnSamePort({ downtimeMs: 300 });
    cleanups.unshift(() => server.shutdown());

    // Client reconnects.
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);

    // Let server's onLoadDocument + server-observer initial sync fully settle
    // on the post-restart side.
    await wait(500);

    // Content durability: disk still has the marker.
    const postRestartDisk = readFileSync(join(contentDir, 'test-doc.md'), 'utf-8');
    expect(postRestartDisk.includes(DURABILITY_MARKER)).toBe(true);

    // The contract is durability AND deduplication. With the
    // server-instance-ID auth defense + the disk-ack baseline
    // selection, mid-drain restart converges to exactly one
    // marker copy on both client and disk:
    //
    //   1. Server's auth-token claim mismatch on reconnect (the client's
    //      cached id seeded from `/api/server-info` is the OLD instance)
    //      triggers `authenticationFailed: server-instance-mismatch`.
    //   2. The mismatch handler buffers the unsynced delta from
    //      `lastDiskAckedSV` (the disk-flush watermark, more conservative
    //      than `lastServerSyncedSV`) — content the server has durably
    //      persisted is NOT in the buffer.
    //   3. `clearData()` wipes IDB; recycle creates a fresh provider.
    //   4. Fresh provider syncs against the post-restart server, whose
    //      Y.Doc was just rebuilt from disk (already includes the marker).
    //   5. The (empty or near-empty) buffer is replayed onto the fresh
    //      Y.Doc — no duplication because the durably-persisted content
    //      is already in the post-restart server state.
    // Read from the post-recycle provider via pool.getActive(). The
    // pre-restart provider's Y.Doc is destroyed by the recycle —
    // Y.Doc.destroy() does NOT clear the share map, so a captured
    // pre-recycle reference would silently return content frozen at
    // the moment of recycle, masking any post-recycle duplication.
    const postEntry = pool.getActive();
    if (!postEntry) throw new Error('no active entry post-restart');
    const clientText = postEntry.provider.document.getText('source').toString();
    const markerCountClient = (clientText.match(new RegExp(DURABILITY_MARKER, 'g')) ?? []).length;
    const markerCountDisk = (postRestartDisk.match(new RegExp(DURABILITY_MARKER, 'g')) ?? [])
      .length;

    expect(markerCountClient).toBe(1);
    expect(markerCountDisk).toBe(1);
  }, 30_000);
});
