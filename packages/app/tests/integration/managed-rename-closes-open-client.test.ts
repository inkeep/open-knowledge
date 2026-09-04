import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  BODY,
  BODY_HEADING_COUNT,
  getHeadings,
  NEW_DOC,
  NEW_FOLDER,
  NEW_PARENT,
  OLD_DOC,
  OLD_FOLDER,
  post,
} from './rename-rebinding.test-helper.ts';
import {
  agentWriteMd,
  createTestClient,
  createTestServer,
  pollUntil,
  type TestClient,
  type TestServer,
} from './test-harness.ts';

describe('the managed rename spine closes the socket, so the tab is not stranded (PRD-8486 control)', () => {
  let server: TestServer;
  let client: TestClient;
  const closeEvents: unknown[] = [];

  beforeAll(async () => {
    server = await createTestServer();
    await post(server.port, '/api/create-folder', { path: OLD_FOLDER });
    await post(server.port, '/api/create-page', { path: OLD_DOC });
    await agentWriteMd(server.port, BODY, { docName: OLD_DOC, position: 'replace' });
    await pollUntil(async () => (await getHeadings(server.port, OLD_DOC)).status === 200, 15_000);
    client = await createTestClient(server.port, OLD_DOC, { skipInvariantWatcher: true });
    client.provider.on('close', (event: unknown) => {
      closeEvents.push(event);
    });
  }, 60_000);

  afterAll(async () => {
    await client?.cleanup().catch(() => {});
    await server?.cleanup().catch(() => {});
  });

  test('POST /api/rename-path disconnects the client, as the watcher path now also does', async () => {
    const before = await getHeadings(server.port, OLD_DOC);
    expect(before.status).toBe(200);
    expect((before.body.headings as unknown[]).length).toBe(BODY_HEADING_COUNT);
    expect(client.provider.isSynced).toBe(true);
    expect(client.provider.isAuthenticated).toBe(true);

    await post(server.port, '/api/create-folder', { path: NEW_PARENT });
    const renamed = await post(server.port, '/api/rename-path', {
      kind: 'folder',
      fromPath: OLD_FOLDER,
      toPath: NEW_FOLDER,
    });
    expect(renamed.status).toBe(200);

    await pollUntil(async () => closeEvents.length > 0, 15_000, 100, 'a server-driven close');

    const lifecycle = client.doc.getMap('lifecycle').toJSON();
    expect(lifecycle).not.toHaveProperty('newPath');

    const after = await getHeadings(server.port, OLD_DOC);
    expect(after.status).toBe(404);

    const newOk = await getHeadings(server.port, NEW_DOC);
    expect(newOk.status).toBe(200);
  }, 90_000);
});
