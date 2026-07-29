/**
 * Client<->server contract for the browser-lifecycle flush/resync.
 *
 * The pool's per-provider gating (which docs flush, kill-switch OFF/ON) is
 * pinned deterministically at the unit tier (provider-pool-flush-on-hide). This
 * suite proves the part that only a real client<->server round-trip can: the
 * flush's `forceSync` actually lands a pending delta on the SERVER (asserted
 * via getServerState — an IDB-only landing does not satisfy it), and a
 * backgrounded-then-visible client reconverges.
 *
 * The outbound-drop models a lost/throttled incremental update; it does NOT
 * reproduce real browser background-throttling (Chrome intensive throttling /
 * Safari App Nap), which is only observable at a browser/long-run rung and is
 * carried as an open residual, not claimed here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  agentWriteMd,
  createTestClient,
  createTestServer,
  getServerState,
  HARNESS_BOOT_TIMEOUT_MS,
  pollUntil,
  type TestServer,
} from './test-harness';

describe('editor lifecycle flush/resync (client<->server)', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await createTestServer();
  }, HARNESS_BOOT_TIMEOUT_MS);
  afterAll(async () => {
    await server.cleanup();
  });

  it('force-sync flush lands a pending delta on the SERVER (IDB-only would not)', async () => {
    const client = await createTestClient(server.port, undefined, {
      syncControl: true,
      skipInvariantWatcher: true,
    });
    try {
      const MARKER = 'FLUSHONHIDEMARKER7c1a';

      // Drop outbound so the incremental update is lost — the provider believes
      // it sent, unsyncedChanges stays > 0, and the server never receives it.
      client.setDropOutbound(true);
      client.doc.transact(() => {
        client.ytext.insert(0, MARKER);
      });
      expect(client.provider.unsyncedChanges).toBeGreaterThan(0);

      const beforeFlush = getServerState(server, client.docName);
      expect(beforeFlush?.ytext.toString().includes(MARKER) ?? false).toBe(false);

      // The flush: stop dropping and forceSync — the exact per-provider op
      // pool.flushOnHide() performs. Delivery is async; poll the SERVER state.
      client.setDropOutbound(false);
      client.provider.forceSync();

      // pollUntil throws on timeout, so reaching the assertion means it landed.
      await pollUntil(
        () => getServerState(server, client.docName)?.ytext.toString().includes(MARKER) ?? false,
        5_000,
      );
      expect(getServerState(server, client.docName)?.ytext.toString()).toContain(MARKER);
    } finally {
      await client.cleanup();
    }
  });

  it('resync-on-visible: a client that missed a server edit reconverges', async () => {
    const client = await createTestClient(server.port, undefined, {
      syncControl: true,
      skipInvariantWatcher: true,
    });
    try {
      const SERVER_EDIT = 'SERVEREDITWHILEHIDDEN91b2';

      // Model a hidden tab missing inbound updates: pause inbound, then a
      // separate writer changes the server doc.
      client.pauseSync();
      await agentWriteMd(server.port, SERVER_EDIT, {
        docName: client.docName,
        position: 'replace',
      });

      // The client has not seen the server edit yet.
      expect(client.ytext.toString().includes(SERVER_EDIT)).toBe(false);

      // Return to foreground: inbound resumes (throttle lifts) and the resync
      // forceSync pulls the client up to date.
      client.resumeSync();
      client.provider.forceSync();

      // pollUntil throws on timeout, so reaching the assertion means it converged.
      await pollUntil(() => client.ytext.toString().includes(SERVER_EDIT), 5_000);
      expect(client.ytext.toString()).toContain(SERVER_EDIT);

      // Client doc equals server doc.
      const serverState = getServerState(server, client.docName);
      expect(client.ytext.toString()).toBe(serverState?.ytext.toString());
    } finally {
      await client.cleanup();
    }
  });
});
