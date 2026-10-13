import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ForwardLinksSuccessSchema } from '@inkeep/open-knowledge-core';
import { afterEach, expect, test, vi } from 'vitest';
import * as fileWatcher from '../../../server/src/file-watcher.ts';
import * as fsTraced from '../../../server/src/fs-traced.ts';
import * as parcelSubscription from '../../../server/src/parcel-subscription.ts';
import * as persistenceModule from '../../../server/src/persistence.ts';
import { runTeardownPhases } from '../stress/_helpers/teardown-fs.ts';
import {
  createTestClient,
  createTestServer,
  type TestClient,
  type TestServer,
} from './test-harness.ts';

const ORIGINAL = '# Reference\n\n[[source]]\n';
const REWRITTEN = '# Reference\n\n[[destination|source]]\n';
const SAVED = `${REWRITTEN}\nStill editable.\n`;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await runTeardownPhases(...cleanups.splice(0).reverse());
});

test('a direct managed rename rewrite adopts a recreated reference before its older delete arrives', async () => {
  const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-stale-managed-rewrite-')));
  const docName = 'reference';
  const filePath = join(contentDir, `${docName}.md`);
  const entered = Promise.withResolvers<void>();
  const releaseDelete = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  const followers = Promise.withResolvers<void>();
  const restores: Array<() => void> = [];
  const writes: Array<{ before: string; after: string; residentContent: string | null }> = [];
  const atomicPublications: string[] = [];
  let server: TestServer | undefined;
  let client: TestClient | undefined;
  let persistence: persistenceModule.PersistenceHandle | undefined;
  let rawTail = Promise.resolve();
  let selectedDeleteSeen = false;
  let handlerHeld = false;
  let clientClosed = false;
  let observingRewrite = false;
  let closing = false;

  const subscribe = parcelSubscription.subscribeParcel;
  const subscriptionSpy = vi
    .spyOn(parcelSubscription, 'subscribeParcel')
    .mockImplementation((parcel, dir, onEvents, options, platform) =>
      subscribe(
        parcel,
        dir,
        (error, events) => {
          if (dir !== contentDir || closing) return onEvents(error, events);
          const selected =
            !selectedDeleteSeen &&
            events.some((event) => event.type === 'delete' && event.path === filePath);
          const follower = selectedDeleteSeen;
          if (selected) selectedDeleteSeen = true;
          const work = rawTail.then(async () => {
            if (follower) await followers.promise;
            await onEvents(error, events);
            if (selected) completed.resolve();
          });
          rawTail = work;
          return work;
        },
        options,
        platform,
      ),
    );
  restores.push(() => subscriptionSpy.mockRestore());
  const startWatcher = fileWatcher.startWatcher;
  const watcherSpy = vi
    .spyOn(fileWatcher, 'startWatcher')
    .mockImplementation((root, onDiskEvent, filter, options) =>
      startWatcher(
        root,
        async (event) => {
          if (!handlerHeld && event.kind === 'delete' && event.docName === docName) {
            handlerHeld = true;
            entered.resolve();
            await releaseDelete.promise;
          }
          await onDiskEvent(event);
        },
        filter,
        { ...options, forceBackend: 'parcel' },
      ),
    );
  restores.push(() => watcherSpy.mockRestore());
  const createPersistence = persistenceModule.createPersistenceExtension;
  const persistenceSpy = vi
    .spyOn(persistenceModule, 'createPersistenceExtension')
    .mockImplementation((options) => {
      const handle = createPersistence(options);
      if (options?.contentDir === contentDir) persistence = handle;
      return handle;
    });
  restores.push(() => persistenceSpy.mockRestore());
  const write = fsTraced.tracedWriteFileSync;
  const writeSpy = vi.spyOn(fsTraced, 'tracedWriteFileSync').mockImplementation((...args) => {
    if (!observingRewrite || args[0] !== filePath) return write(...args);
    const before = readFileSync(filePath, 'utf8');
    write(...args);
    writes.push({
      before,
      after: readFileSync(filePath, 'utf8'),
      residentContent:
        server?.instance.hocuspocus.documents.get(docName)?.getText('source').toString() ?? null,
    });
  });
  restores.push(() => writeSpy.mockRestore());
  const rename = fsTraced.tracedRenameSync;
  const renameSpy = vi.spyOn(fsTraced, 'tracedRenameSync').mockImplementation((from, to) => {
    rename(from, to);
    if (observingRewrite && to === filePath) {
      atomicPublications.push(readFileSync(filePath, 'utf8'));
    }
  });
  restores.push(() => renameSpy.mockRestore());

  cleanups.push(async () => {
    closing = true;
    releaseDelete.resolve();
    followers.resolve();
    await runTeardownPhases(
      () => rawTail,
      async () => {
        await client?.cleanup();
      },
      async () => {
        await server?.cleanup();
      },
      () => {
        for (const restore of restores.reverse()) restore();
      },
      () => rmSync(contentDir, { recursive: true, force: true }),
    );
  });

  writeFileSync(filePath, ORIGINAL, { flag: 'wx' });
  writeFileSync(join(contentDir, 'source.md'), '# Source\n', { flag: 'wx' });
  mkdirSync(join(contentDir, '.ok', 'templates'), { recursive: true });
  writeFileSync(join(contentDir, '.ok', 'templates', 'same-reference.md'), ORIGINAL, {
    flag: 'wx',
  });
  server = await createTestServer({ contentDir });
  const running = server;
  const post = (path: string, body: unknown) =>
    fetch(`${running.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  client = await createTestClient(running.port, docName, { resetOnCleanup: false });
  const connected = client;
  connected.provider.on('close', () => {
    clientClosed = true;
  });
  const resident = running.instance.hocuspocus.documents.get(docName);
  if (!resident || !persistence) throw new Error('Real reference and persistence were not loaded');
  const store = persistence;
  expect(connected.ytext.toString()).toBe(ORIGINAL);
  const linksResponse = await fetch(`${running.baseUrl}/api/forward-links?docName=${docName}`);
  expect(linksResponse.status).toBe(200);
  const links = ForwardLinksSuccessSchema.parse(await linksResponse.json());
  expect(links.forwardLinks).toContainEqual(
    expect.objectContaining({ kind: 'doc', docName: 'source' }),
  );

  unlinkSync(filePath);
  await entered.promise;
  expect(selectedDeleteSeen).toBe(true);
  expect(existsSync(filePath)).toBe(false);
  const created = await post('/api/create-page', {
    path: 'reference.md',
    template: 'same-reference',
  });
  expect(created.status).toBe(200);
  expect(await created.json()).toEqual({ docName });
  expect(readFileSync(filePath, 'utf8')).toBe(ORIGINAL);
  expect(running.instance.hocuspocus.documents.get(docName)).toBe(resident);
  expect(resident.getText('source').toString()).toBe(ORIGINAL);
  expect(clientClosed).toBe(false);
  observingRewrite = true;

  const renamed = await post('/api/rename-path', {
    kind: 'file',
    fromPath: 'source',
    toPath: 'destination',
  });
  const renameBody: unknown = await renamed.json();
  expect(renamed.status, JSON.stringify(renameBody)).toBe(200);
  expect(renameBody).toMatchObject({
    renamed: [{ fromDocName: 'source', toDocName: 'destination' }],
    rewrittenDocs: expect.arrayContaining([expect.objectContaining({ docName, rewrites: 1 })]),
  });
  expect(writes).toContainEqual({ before: ORIGINAL, after: REWRITTEN, residentContent: REWRITTEN });
  expect(running.instance.hocuspocus.documents.get(docName)).toBe(resident);
  expect(resident.getText('source').toString()).toBe(REWRITTEN);
  expect(readFileSync(filePath, 'utf8')).toBe(REWRITTEN);
  expect(running.instance.durabilityState.getReconciledBase(docName)).toBe(REWRITTEN);
  await store.forceStore(resident, docName);
  expect(atomicPublications).toEqual([]);
  expect(readFileSync(filePath, 'utf8')).toBe(REWRITTEN);
  await expect.poll(() => connected.ytext.toString()).toBe(REWRITTEN);

  releaseDelete.resolve();
  await completed.promise;
  expect(running.instance.hocuspocus.documents.get(docName)).toBe(resident);
  expect(resident.getMap('lifecycle').get('status')).toBeUndefined();
  expect(resident.getText('source').toString()).toBe(REWRITTEN);
  expect(readFileSync(filePath, 'utf8')).toBe(REWRITTEN);
  expect(clientClosed).toBe(false);
  expect(atomicPublications).toEqual([]);
  observingRewrite = false;

  const saved = await post('/api/agent-write-md', {
    docName,
    markdown: '\nStill editable.\n',
    position: 'append',
    agentId: 'managed-rename-continuation',
  });
  expect(saved.status).toBe(200);
  expect(running.instance.hocuspocus.documents.get(docName)).toBe(resident);
  expect(readFileSync(filePath, 'utf8')).toBe(SAVED);
  await expect.poll(() => connected.ytext.toString()).toBe(SAVED);
});
