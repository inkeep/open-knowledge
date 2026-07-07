/**
 * T6 — Agent write during server restart.
 *
 * Flow:
 *   1. Browser client (simulated via ProviderPool) connects to server with
 *      empty doc. Waits for sync.
 *   2. Agent writes content-1 via HTTP POST /api/agent-write-md. Server's
 *      applyAgentMarkdownWrite runs inside session.dc.document.transact under
 *      session.origin. Browser client receives sync updates.
 *   3. Fast server restart (downtimeMs: 500, inside recycle debounce window).
 *      Browser pool keeps stale Y.Doc.
 *   4. Agent writes content-2 via HTTP POST to the newly-restarted server.
 *      New agent session created (server in-memory session map was reset).
 *      applyAgentMarkdownWrite runs against the fresh server Y.Doc.
 *
 * Expected: PASS. Regression guard for the bug class:
 * before the client-persistence + buffer-and-replay landing, step 3's stale
 * Y.Doc merge with the fresh server Y.Doc duplicated content-1, then
 * content-2 landed once on the already-duplicated state. The test asserts
 * content-1 and content-2 each appear exactly once on disk and in the
 * browser client's Y.Doc — any reintroduction of the duplication path
 * trips it red.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { ProviderPool } from '../../src/editor/provider-pool';
import {
  agentWriteMd,
  createRestartableServer,
  pollDiskContentStable,
  pollUntil,
  seedPoolServerInstanceId,
} from './test-harness';

const PRE_RESTART_MARKER = 'T6-PRE-RESTART-agent-write-alpha';
const POST_RESTART_MARKER = 'T6-POST-RESTART-agent-write-bravo';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe('T6: Agent write during restart', () => {
  test('REPRO: agent writes pre- and post-restart, tab open — no duplication', async () => {
    let server = await createRestartableServer();
    cleanups.push(() => server.shutdown());

    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());
    await seedPoolServerInstanceId(server, pool);

    pool.open('test-doc');
    pool.setActive('test-doc');
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);

    const firstProvider = pool.getActive()?.provider;
    if (!firstProvider) throw new Error('pre-restart provider missing');

    // Pre-restart: agent writes content-1.
    await agentWriteMd(server.port, `\n\n${PRE_RESTART_MARKER}\n`, {
      docName: 'test-doc',
      position: 'append',
      agentId: 't6-agent-1',
      agentName: 'T6-Agent-Pre',
    });

    // Wait for browser to see the write.
    await pollUntil(
      () =>
        pool
          .getActive()
          ?.provider.document.getText('source')
          .toString()
          .includes(PRE_RESTART_MARKER) ?? false,
      8000,
      50,
    );

    // Wait for persistence debounce to land content-1 on disk.
    await pollDiskContentStable(
      join(server.contentDir, 'test-doc.md'),
      (c) => c.includes(PRE_RESTART_MARKER),
      { timeoutMs: 5000, settleMs: 300 },
    );

    // Fast restart.
    server = await server.killAndRestartOnSamePort({ downtimeMs: 500 });
    cleanups.unshift(() => server.shutdown());

    // Browser pool re-syncs — fresh provider
    // (recycle on server-instance-mismatch). Mechanism
    // precondition dropped; the real assertion is "no duplication of
    // PRE_RESTART_MARKER on disk" below.
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);

    // Small settle so the reconnect sync (including any duplication) completes
    // before the next agent write lands on the server.
    await wait(500);

    // Post-restart: agent writes content-2 via HTTP to the new server.
    await agentWriteMd(server.port, `\n\n${POST_RESTART_MARKER}\n`, {
      docName: 'test-doc',
      position: 'append',
      agentId: 't6-agent-2',
      agentName: 'T6-Agent-Post',
    });

    // Wait for browser to see content-2.
    await pollUntil(
      () =>
        pool
          .getActive()
          ?.provider.document.getText('source')
          .toString()
          .includes(POST_RESTART_MARKER) ?? false,
      8000,
      50,
    );

    // Wait for persistence to flush.
    const finalDisk = await pollDiskContentStable(
      join(server.contentDir, 'test-doc.md'),
      (c) => c.includes(PRE_RESTART_MARKER) && c.includes(POST_RESTART_MARKER),
      { timeoutMs: 8000, settleMs: 400 },
    );

    const diskPreMarker = (finalDisk.match(new RegExp(PRE_RESTART_MARKER, 'g')) ?? []).length;
    const diskPostMarker = (finalDisk.match(new RegExp(POST_RESTART_MARKER, 'g')) ?? []).length;

    const activeEntry = pool.getActive();
    if (!activeEntry) throw new Error('pool has no active entry after reconnect');
    const clientText = activeEntry.provider.document.getText('source').toString();
    const clientPreMarker = (clientText.match(new RegExp(PRE_RESTART_MARKER, 'g')) ?? []).length;
    const clientPostMarker = (clientText.match(new RegExp(POST_RESTART_MARKER, 'g')) ?? []).length;

    console.log('[T6] marker counts', {
      disk: { pre: diskPreMarker, post: diskPostMarker, bytes: finalDisk.length },
      client: { pre: clientPreMarker, post: clientPostMarker, bytes: clientText.length },
    });

    // Both writes should appear exactly once.
    expect(diskPreMarker).toBe(1);
    expect(diskPostMarker).toBe(1);
    expect(clientPreMarker).toBe(1);
    expect(clientPostMarker).toBe(1);
  }, 45_000);
});
