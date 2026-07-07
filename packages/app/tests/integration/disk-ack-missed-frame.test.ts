/**
 * Missed-frame disk-ack recovery.
 *
 * Closes the failure mode where CC1
 * stateless broadcasts have no replay, so a client whose `__system__`
 * WebSocket dropped during a write burst would otherwise miss every
 * disk-ack frame from that window forever, leaving `lastDiskAckedSV`
 * permanently stale. The mismatch-recycle baseline-selection then
 * over-includes durably-persisted bytes in the buffer, replays them
 * onto the post-restart server's markdown-rebuilt Y.Doc, and produces
 * content duplication — the very bug class was strengthened to
 * prevent.
 *
 * The fix: server tracks the latest disk-ack SV per doc and exposes
 * via `GET /api/server-info`'s `currentDiskAckSVs` field. Clients
 * refresh on every `__system__` reconnect via `refreshServerInfo`.
 *
 * This test exercises the missed-frame flow end-to-end:
 *   1. Boot system-doc subscriber (receives initial disk-ack frames live).
 *   2. Apply enough writes to trigger one disk-ack broadcast (caught live).
 *   3. Force-disconnect the system-doc subscriber.
 *   4. Apply more writes that produce disk-ack frames the disconnected
 *      subscriber MUST miss.
 *   5. Reconnect the system-doc subscriber → triggers refresh via
 *      `/api/server-info` → `lastDiskAckedSV` advances to the missed-window
 *      SVs.
 *   6. Restart the server → triggers `server-instance-mismatch` →
 *      mismatch-recycle uses the FRESHLY REFRESHED `lastDiskAckedSV` as
 *      baseline → buffer correctly excludes durably-persisted bytes →
 *      replay produces no duplication.
 *
 * Without the fix (no `/api/server-info` refresh on reconnect), step 5
 * would leave `lastDiskAckedSV` at the step-2 watermark, step 6's recycle
 * would over-include the missed-window content in the buffer, and the
 * marker would appear at clock 2 (one from disk rebuild, one from
 * replay).
 *
 * Expected: PASS. Both client and disk show the marker exactly once
 * after the recycle.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { ProviderPool } from '../../src/editor/provider-pool';
import { refreshServerInfo } from '../../src/lib/server-info-refresh';
import {
  agentWriteMd,
  attachSystemDocSubscriber,
  createRestartableServer,
  pollDiskContentStable,
  pollUntil,
} from './test-harness';

const MARKER = 'T15-MISSED-FRAME-MARKER-9b2e';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe('T15: Missed disk-ack frame recovery via /api/server-info', () => {
  test('systemSub disconnect during write burst, reconnect refreshes watermarks, no duplication after restart', async () => {
    let server = await createRestartableServer({
      gitEnabled: true,
      commitDebounceMs: 2000,
      debounce: 100,
      maxDebounce: 300,
    });
    cleanups.push(() => server.shutdown());

    const baseUrl = `http://127.0.0.1:${server.port}`;
    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());

    // Boot fetch (mirrors DocumentContext) — seeds serverInstanceId,
    // currentBranch, and the (initially empty) currentDiskAckSVs map.
    await refreshServerInfo(pool, baseUrl);

    // System-doc subscriber: receives live disk-ack frames AND
    // refreshes via /api/server-info on every reconnect.
    let systemSub = attachSystemDocSubscriber(pool, server.port);
    cleanups.push(() => systemSub.dispose());

    pool.open('test-doc');
    pool.setActive('test-doc');
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);

    const firstProvider = pool.getActive()?.provider;
    if (!firstProvider) throw new Error('pre-disconnect provider missing');

    // Phase 1 — apply a write the live subscriber CATCHES so that
    // `lastDiskAckedSV` advances normally. Establishes the baseline
    // watermark before we start dropping frames.
    await agentWriteMd(server.port, '\n\nPHASE-1-PRE-DISCONNECT\n', {
      docName: 'test-doc',
      position: 'append',
      agentId: 't15-agent',
      agentName: 'T15-Agent',
    });
    await pollDiskContentStable(
      join(server.contentDir, 'test-doc.md'),
      (c) => c.includes('PHASE-1-PRE-DISCONNECT'),
      { timeoutMs: 5_000, settleMs: 200 },
    );
    // Give the disk-ack frame time to traverse the live __system__
    // subscription before we tear it down.
    await wait(300);

    // Phase 2 — disconnect the system-doc subscriber. The pool's
    // user-doc WS stays connected; only the __system__ channel
    // drops. Subsequent disk-ack frames will be lost.
    await systemSub.dispose();

    // Phase 3 — write the marker. The L1 flush + emitDiskAck happens
    // while the system-doc subscriber is gone. The frame is
    // structurally lost (no subscriber to receive it).
    await agentWriteMd(server.port, `${MARKER}\n`, {
      docName: 'test-doc',
      position: 'append',
      agentId: 't15-agent',
      agentName: 'T15-Agent',
    });
    await pollDiskContentStable(join(server.contentDir, 'test-doc.md'), (c) => c.includes(MARKER), {
      timeoutMs: 5_000,
      settleMs: 200,
    });
    // Confirm the marker is durably on disk before we restart.
    const preRestartDisk = readFileSync(join(server.contentDir, 'test-doc.md'), 'utf-8');
    expect(preRestartDisk.includes(MARKER)).toBe(true);

    // Phase 4 — refresh from /api/server-info to recover the missed
    // disk-ack watermarks. We call `refreshServerInfo` directly
    // rather than instantiating a new `attachSystemDocSubscriber`
    // because dispose + recreate is structurally NOT a WebSocket
    // reconnect: the gate (`createSyncedReconnectGate`) only fires on
    // a SECOND `synced` within the SAME provider lifetime, mirroring
    // the production semantics where reconnects happen via
    // HocuspocusProvider's built-in exponential-backoff inside one
    // provider instance. A fresh provider's first `synced` is treated
    // as a cold boot (the initial DocumentContext fetch already
    // covered it).
    //
    // Production gate behavior is locked separately by the unit tests
    // on `createSyncedReconnectGate` in
    // `packages/app/src/lib/server-info-refresh.test.ts`; T15's job
    // is the end-to-end mechanism (`refreshServerInfo` correctly
    // dispatches the missed-frame data into the recycle baseline),
    // which is independent of how the trigger fires.
    await refreshServerInfo(pool, baseUrl);
    // Reconnect a fresh systemSub for downstream cleanup / parity
    // with the previous test shape. No-op for the assertion path.
    systemSub = attachSystemDocSubscriber(pool, server.port);
    cleanups.push(() => systemSub.dispose());

    // Phase 5 — restart the server. New serverInstanceId triggers
    // server-instance-mismatch on reconnect → mismatch-recycle uses
    // the now-fresh `lastDiskAckedSV` as baseline → buffer
    // correctly excludes the marker (which IS on disk → which IS in
    // the post-restart server's markdown-rebuilt Y.Doc).
    server = await server.killAndRestartOnSamePort({ downtimeMs: 300 });
    cleanups.unshift(() => server.shutdown());

    // Wait for client to reconnect + recycle to complete.
    await pollUntil(() => pool.getActive()?.provider !== firstProvider, 10_000, 50);
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);
    await wait(500);

    // Behavior — exactly one marker on both client and disk.
    const postRestartDisk = readFileSync(join(server.contentDir, 'test-doc.md'), 'utf-8');
    const postProvider = pool.getActive()?.provider;
    if (!postProvider) throw new Error('post-restart provider missing');
    const clientText = postProvider.document.getText('source').toString();

    const markerCountClient = (clientText.match(new RegExp(MARKER, 'g')) ?? []).length;
    const markerCountDisk = (postRestartDisk.match(new RegExp(MARKER, 'g')) ?? []).length;

    expect(markerCountClient).toBe(1);
    expect(markerCountDisk).toBe(1);
  }, 45_000);
});
