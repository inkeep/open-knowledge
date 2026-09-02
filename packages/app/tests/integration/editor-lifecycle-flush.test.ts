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

      client.setDropOutbound(true);
      client.doc.transact(() => {
        client.ytext.insert(0, MARKER);
      });
      expect(client.provider.unsyncedChanges).toBeGreaterThan(0);

      const beforeFlush = getServerState(server, client.docName);
      expect(beforeFlush?.ytext.toString().includes(MARKER) ?? false).toBe(false);

      client.setDropOutbound(false);
      client.provider.forceSync();

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

      client.pauseSync();
      await agentWriteMd(server.port, SERVER_EDIT, {
        docName: client.docName,
        position: 'replace',
      });

      expect(client.ytext.toString().includes(SERVER_EDIT)).toBe(false);

      client.resumeSync();
      client.provider.forceSync();

      await pollUntil(() => client.ytext.toString().includes(SERVER_EDIT), 5_000);
      expect(client.ytext.toString()).toContain(SERVER_EDIT);

      const serverState = getServerState(server, client.docName);
      expect(client.ytext.toString()).toBe(serverState?.ytext.toString());
    } finally {
      await client.cleanup();
    }
  });
});
