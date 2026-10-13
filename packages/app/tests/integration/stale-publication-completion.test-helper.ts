import { randomUUID } from 'node:crypto';
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
import type { Document } from '@hocuspocus/server';
import { expect, vi } from 'vitest';
import * as fileWatcher from '../../../server/src/file-watcher.ts';
import * as fsTraced from '../../../server/src/fs-traced.ts';
import * as parcelSubscription from '../../../server/src/parcel-subscription.ts';
import { runTeardownPhases } from '../stress/_helpers/teardown-fs.ts';
import {
  createTestClient,
  createTestServer,
  type TestClient,
  type TestServer,
} from './test-harness.ts';

export const ORIGINAL_PUBLICATION = '# Original page\n\nInitial body.\n';
export const PENDING_PUBLICATION = '# Pending publication\n\nFrom the original connection.\n';

type DeletionPlan = {
  hold: 'none' | 'classified';
  nativeSeen: boolean;
  held: boolean;
  reached: PromiseWithResolvers<void>;
  release: PromiseWithResolvers<void>;
  followers: PromiseWithResolvers<void>;
  completed: PromiseWithResolvers<void>;
};

export async function startStalePublicationScenario(
  registerCleanup: (cleanup: () => Promise<void>) => void,
) {
  const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-stale-publication-')));
  const docName = `publication-${randomUUID()}`;
  const filePath = join(contentDir, `${docName}.md`);
  const clients = new Set<TestClient>();
  const closedClients = new WeakSet<TestClient>();
  const plans: DeletionPlan[] = [];
  const trace: Array<Record<string, unknown>> = [];
  const staged = Promise.withResolvers<void>();
  const releasePublication = Promise.withResolvers<void>();
  const storeCompleted = Promise.withResolvers<void>();
  const requests = new Set<Promise<Response>>();
  const nativeAppearances = new Set<PromiseWithResolvers<void>>();
  let server: TestServer | undefined;
  let originalDocument: Document | undefined;
  let upcomingPlan: DeletionPlan | undefined;
  let activePlan: DeletionPlan | undefined;
  let processingPlan: DeletionPlan | undefined;
  let rawTail = Promise.resolve();
  let heldTempPath: string | undefined;
  let published = false;
  let closing = false;
  const restore: Array<() => void> = [];

  registerCleanup(async () => {
    closing = true;
    releasePublication.resolve();
    for (const plan of plans) {
      plan.release.resolve();
      plan.followers.resolve();
    }
    await runTeardownPhases(
      () => rawTail,
      async () => {
        await Promise.allSettled(requests);
      },
      ...Array.from(clients, (client) => () => client.cleanup()),
      async () => {
        await server?.cleanup();
      },
      () => {
        for (const reset of restore.reverse()) reset();
      },
      () => rmSync(contentDir, { recursive: true, force: true }),
      () => {
        console.info(
          JSON.stringify({
            event: 'stale-publication-history',
            docName,
            trace,
            fixtureAbsent: !existsSync(contentDir),
          }),
        );
      },
    );
  });

  const subscribe = parcelSubscription.subscribeParcel;
  const subscriptionSpy = vi
    .spyOn(parcelSubscription, 'subscribeParcel')
    .mockImplementation((parcel, dir, onEvents, options, platform) =>
      subscribe(
        parcel,
        dir,
        (error, events) => {
          if (dir !== contentDir || closing) return onEvents(error, events);
          const canonicalEvents = events.filter((event) => event.path === filePath);
          if (canonicalEvents.length > 0) {
            trace.push({
              phase: 'native-canonical-events',
              types: canonicalEvents.map((event) => event.type),
              filePresent: existsSync(filePath),
            });
          }
          const appearances = canonicalEvents.some((event) => event.type !== 'delete')
            ? [...nativeAppearances]
            : [];
          const selected =
            upcomingPlan &&
            events.some((event) => event.type === 'delete' && event.path === filePath)
              ? upcomingPlan
              : undefined;
          if (selected) {
            selected.nativeSeen = true;
            upcomingPlan = undefined;
            activePlan = selected;
            trace.push({
              phase: 'native-delete',
              ordinal: plans.indexOf(selected),
              fileAbsent: !existsSync(filePath),
            });
          }
          const follower = selected ? undefined : activePlan;
          const work = rawTail.then(async () => {
            await follower?.followers.promise;
            processingPlan = selected;
            try {
              await onEvents(error, events);
              for (const appearance of appearances) {
                nativeAppearances.delete(appearance);
                trace.push({
                  phase: 'native-appearance-consumed',
                  filePresent: existsSync(filePath),
                });
                appearance.resolve();
              }
              selected?.completed.resolve();
            } finally {
              processingPlan = undefined;
            }
          });
          rawTail = work;
          return work;
        },
        options,
        platform,
      ),
    );
  restore.push(() => subscriptionSpy.mockRestore());

  const startWatcher = fileWatcher.startWatcher;
  const watcherSpy = vi
    .spyOn(fileWatcher, 'startWatcher')
    .mockImplementation((root, onDiskEvent, filter, options) =>
      startWatcher(
        root,
        async (event) => {
          if (
            event.kind === 'delete' &&
            event.docName === docName &&
            processingPlan?.hold === 'classified'
          ) {
            processingPlan.held = true;
            trace.push({ phase: 'classified-delete-held', ordinal: plans.indexOf(processingPlan) });
            processingPlan.reached.resolve();
            await processingPlan.release.promise;
          }
          await onDiskEvent(event);
        },
        filter,
        { ...options, forceBackend: 'parcel' },
      ),
    );
  restore.push(() => watcherSpy.mockRestore());

  const write = fsTraced.tracedWriteFile;
  const writeSpy = vi.spyOn(fsTraced, 'tracedWriteFile').mockImplementation(async (...args) => {
    await write(...args);
    if (
      heldTempPath ||
      !String(args[0]).startsWith(`${filePath}.tmp.`) ||
      args[1] !== PENDING_PUBLICATION
    )
      return;
    heldTempPath = String(args[0]);
    trace.push({
      phase: 'real-store-staged',
      residentText: originalDocument?.getText('source').toString(),
      saveMutexLocked: originalDocument?.saveMutex.isLocked(),
    });
    staged.resolve();
    await releasePublication.promise;
  });
  restore.push(() => writeSpy.mockRestore());

  const rename = fsTraced.tracedRenameSync;
  const renameSpy = vi.spyOn(fsTraced, 'tracedRenameSync').mockImplementation((...args) => {
    rename(...args);
    if (String(args[0]) !== heldTempPath || String(args[1]) !== filePath) return;
    published = true;
    trace.push({
      phase: 'old-store-published',
      originalDestroyed: originalDocument?.isDestroyed,
      mappedIsOriginal: server?.instance.hocuspocus.documents.get(docName) === originalDocument,
      disk: readFileSync(filePath, 'utf8'),
    });
  });
  restore.push(() => renameSpy.mockRestore());

  writeFileSync(filePath, ORIGINAL_PUBLICATION, { flag: 'wx' });
  mkdirSync(join(contentDir, '.ok', 'templates'), { recursive: true });
  writeFileSync(
    join(contentDir, '.ok', 'templates', 'pending-publication.md'),
    PENDING_PUBLICATION,
    { flag: 'wx' },
  );
  server = await createTestServer({ contentDir });
  const running = server;
  running.instance.hocuspocus.configuration.extensions.push({
    async afterStoreDocument({ document, documentName }) {
      if (documentName === docName && document === originalDocument && published) {
        trace.push({ phase: 'old-store-completed', originalDestroyed: document.isDestroyed });
        storeCompleted.resolve();
      }
    },
  });

  const post = (route: string, body: unknown) => {
    const request = fetch(`${running.baseUrl}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    requests.add(request);
    void request.then(
      () => requests.delete(request),
      () => requests.delete(request),
    );
    return request;
  };

  return {
    server: running,
    docName,
    filePath,
    trace,
    disk: () => readFileSync(filePath, 'utf8'),
    resident: () => running.instance.hocuspocus.documents.get(docName),
    clientClosed: (client: TestClient) => closedClients.has(client),
    async open() {
      const client = await createTestClient(running.port, docName, { resetOnCleanup: false });
      clients.add(client);
      client.provider.on('close', () => {
        closedClients.add(client);
        client.provider.disconnect();
      });
      trace.push({
        phase: 'websocket-connected',
        originalDestroyed: originalDocument?.isDestroyed,
        mappedIsOriginal: running.instance.hocuspocus.documents.get(docName) === originalDocument,
      });
      return client;
    },
    observeNextNativeAppearance() {
      const appearance = Promise.withResolvers<void>();
      nativeAppearances.add(appearance);
      return appearance.promise;
    },
    async startPendingWrite(client: TestClient) {
      originalDocument = running.instance.hocuspocus.documents.get(docName);
      if (!originalDocument) throw new Error('Expected the original resident');
      client.doc.transact(() => {
        client.ytext.delete(0, client.ytext.length);
        client.ytext.insert(0, PENDING_PUBLICATION);
      });
      await staged.promise;
      expect(originalDocument.getText('source').toString()).toBe(PENDING_PUBLICATION);
      expect(readFileSync(filePath, 'utf8')).toBe(ORIGINAL_PUBLICATION);
      return originalDocument;
    },
    async finishPendingWrite() {
      releasePublication.resolve();
      await storeCompleted.promise;
      expect(published).toBe(true);
      expect(readFileSync(filePath, 'utf8')).toBe(PENDING_PUBLICATION);
    },
    armDeletion(hold: DeletionPlan['hold']) {
      if (upcomingPlan) throw new Error('An earlier native deletion has not arrived');
      const plan: DeletionPlan = {
        hold,
        nativeSeen: false,
        held: false,
        reached: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
        followers: Promise.withResolvers<void>(),
        completed: Promise.withResolvers<void>(),
      };
      plans.push(plan);
      upcomingPlan = plan;
      return {
        waitUntilHeld: () => plan.reached.promise,
        async finish(releaseFollowers = false) {
          plan.release.resolve();
          await plan.completed.promise;
          expect(plan.nativeSeen).toBe(true);
          if (releaseFollowers) plan.followers.resolve();
        },
      };
    },
    deleteExternally: () => {
      unlinkSync(filePath);
      trace.push({ phase: 'external-unlink-completed', ordinal: plans.length - 1 });
    },
    async deleteThroughApi() {
      const response = await post('/api/delete-path', { kind: 'file', path: docName });
      expect(response.status).toBe(200);
      trace.push({
        phase: 'api-delete-completed',
        originalDestroyed: originalDocument?.isDestroyed,
        residentPresent: running.instance.hocuspocus.documents.has(docName),
      });
    },
    async recreate() {
      const response = await post('/api/create-page', {
        path: `${docName}.md`,
        template: 'pending-publication',
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ docName });
      expect(readFileSync(filePath, 'utf8')).toBe(PENDING_PUBLICATION);
      trace.push({
        phase: 'exclusive-recreation-completed',
        originalDestroyed: originalDocument?.isDestroyed,
        mappedIsOriginal: running.instance.hocuspocus.documents.get(docName) === originalDocument,
      });
    },
  };
}
