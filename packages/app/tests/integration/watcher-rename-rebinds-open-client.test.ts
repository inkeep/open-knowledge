import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { getMetrics } from '@inkeep/open-knowledge-server';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  BODY,
  BODY_HEADING_COUNT,
  getHeadings,
  NEW_DOC,
  OLD_DOC,
  seedRenameFixtureContentDir,
} from './rename-rebinding.test-helper.ts';
import {
  awaitFileWatcherIndexed,
  createTestClient,
  createTestServer,
  pollUntil,
  readTestDoc,
  type TestClient,
  type TestServer,
} from './test-harness.ts';

const CLIENT_FORCED_CLOSE_REASON = 'forced';

function lifecycleStatus(server: TestServer, docName: string): unknown {
  return server.instance.hocuspocus.documents.get(docName)?.getMap('lifecycle').get('status');
}

async function attachClient(server: TestServer, docName: string) {
  const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
  const closeEvents: Array<{ event?: { code?: number; reason?: string } }> = [];
  const authFailures: string[] = [];
  client.provider.on('close', (event: { event?: { code?: number; reason?: string } }) => {
    closeEvents.push(event);
  });
  client.provider.on('authenticationFailed', ({ reason }: { reason: string }) => {
    authFailures.push(reason);
  });
  return { client, closeEvents, authFailures };
}

describe('an external (git-sync/watcher) move rebinds the open tab (PRD-8486)', () => {
  let server: TestServer;
  let oldClient: TestClient | undefined;
  let newClient: TestClient | undefined;
  let reboundClient: TestClient | undefined;

  beforeAll(async () => {
    server = await createTestServer({
      contentDir: seedRenameFixtureContentDir('ok-watcher-rename-'),
    });
    await awaitFileWatcherIndexed(server, OLD_DOC);
    await pollUntil(async () => (await getHeadings(server.port, OLD_DOC)).status === 200, 15_000);
  }, 60_000);

  afterAll(async () => {
    await oldClient?.cleanup().catch(() => {});
    await newClient?.cleanup().catch(() => {});
    await reboundClient?.cleanup().catch(() => {});
    await server?.cleanup().catch(() => {});
  });

  test('a raw on-disk move disconnects the open client and redirects it to the new docName', async () => {
    const attached = await attachClient(server, OLD_DOC);
    oldClient = attached.client;
    const { closeEvents, authFailures } = attached;

    const before = await getHeadings(server.port, OLD_DOC);
    expect(before.status).toBe(200);
    expect((before.body.headings as unknown[]).length).toBe(BODY_HEADING_COUNT);
    expect(oldClient.provider.isSynced).toBe(true);
    expect(oldClient.provider.isAuthenticated).toBe(true);

    renameSync(join(server.contentDir, `${OLD_DOC}.md`), join(server.contentDir, `${NEW_DOC}.md`));

    await pollUntil(async () => (await getHeadings(server.port, NEW_DOC)).status === 200, 30_000);
    await pollUntil(async () => closeEvents.length > 0, 20_000, 100, 'a server-driven close');

    const first = closeEvents[0];
    expect(first.event?.reason).toBeTruthy();
    expect(first.event?.reason).not.toBe(CLIENT_FORCED_CLOSE_REASON);
    expect(oldClient.provider.isAuthenticated).toBe(false);

    await oldClient.provider.sendToken();
    await pollUntil(async () => authFailures.length > 0, 30_000, 100, 'an auth rejection');
    expect(authFailures[0]).toBe(`rename-redirect:${NEW_DOC}`);

    const after = await getHeadings(server.port, OLD_DOC);
    expect(after.status).toBe(404);
    expect(after.body.type).toBe('urn:ok:error:doc-not-found');
    expect(after.body.title).toBe('Page not found.');

    const newOk = await getHeadings(server.port, NEW_DOC);
    expect(newOk.status).toBe(200);
  }, 120_000);

  test('moving the document back does not trap the rebound client in a redirect cycle', async () => {
    const attached = await attachClient(server, NEW_DOC);
    newClient = attached.client;
    const { closeEvents, authFailures } = attached;
    expect(newClient.provider.isAuthenticated).toBe(true);

    renameSync(join(server.contentDir, `${NEW_DOC}.md`), join(server.contentDir, `${OLD_DOC}.md`));

    await pollUntil(async () => (await getHeadings(server.port, OLD_DOC)).status === 200, 30_000);
    await pollUntil(async () => closeEvents.length > 0, 20_000, 100, 'a server-driven close');
    expect(newClient.provider.isAuthenticated).toBe(false);

    await newClient.provider.sendToken();
    await pollUntil(async () => authFailures.length > 0, 30_000, 100, 'an auth rejection');
    expect(authFailures[0]).toBe(`rename-redirect:${OLD_DOC}`);
    expect(getMetrics().removalRedirectChainCycles).toBe(0);

    expect(lifecycleStatus(server, OLD_DOC)).toBeUndefined();

    reboundClient = await createTestClient(server.port, OLD_DOC, { skipInvariantWatcher: true });
    await pollUntil(
      () => reboundClient?.ytext.toString().includes('# Liveblocks') ?? false,
      15_000,
      100,
      'the reopened document to sync',
    );

    const marker = 'Written after the move back.';
    reboundClient.ytext.insert(reboundClient.ytext.length, `\n${marker}\n`);
    await pollUntil(
      () => readTestDoc(server.contentDir, OLD_DOC).includes(marker),
      20_000,
      100,
      'the post-move-back write to reach disk',
    );
  }, 120_000);
});

describe('an external move of a document with unflushed edits rescues them (PRD-8486)', () => {
  let server: TestServer;
  let client: TestClient | undefined;

  beforeAll(async () => {
    server = await createTestServer({
      contentDir: seedRenameFixtureContentDir('ok-watcher-rename-rescue-'),
      gitEnabled: true,
      debounce: 60_000,
      maxDebounce: 120_000,
    });
    await awaitFileWatcherIndexed(server, OLD_DOC);
  }, 60_000);

  afterAll(async () => {
    await client?.cleanup().catch(() => {});
    await server?.cleanup().catch(() => {});
  });

  test('edits typed inside the persistence debounce window land in a rescue checkpoint', async () => {
    client = await createTestClient(server.port, OLD_DOC, { skipInvariantWatcher: true });
    await pollUntil(() => client?.ytext.toString() === BODY, 15_000, 100, 'initial sync');

    const unflushed = 'Typed after the last flush.';
    client.ytext.insert(client.ytext.length, `\n${unflushed}\n`);
    await pollUntil(
      () =>
        server.instance.hocuspocus.documents
          .get(OLD_DOC)
          ?.getText('source')
          .toString()
          .includes(unflushed) ?? false,
      15_000,
      100,
      'the server doc to carry the edit',
    );

    const rescuesBefore = getMetrics().rescueBufferCount;
    renameSync(join(server.contentDir, `${OLD_DOC}.md`), join(server.contentDir, `${NEW_DOC}.md`));

    await pollUntil(() => lifecycleStatus(server, OLD_DOC) === 'renamed', 30_000);
    await pollUntil(
      () => getMetrics().rescueBufferCount > rescuesBefore,
      15_000,
      100,
      'a rescue checkpoint',
    );

    const res = await fetch(`http://127.0.0.1:${server.port}/api/rescue`);
    expect(res.status).toBe(200);
    const entries = (await res.json()) as Array<{ docName: string; source: string }>;
    expect(entries.some((e) => e.docName === OLD_DOC && e.source === 'timeline')).toBe(true);
  }, 120_000);
});
