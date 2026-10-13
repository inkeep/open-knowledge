import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetricsReconciliationSuccessSchema } from '@inkeep/open-knowledge-core';
import { afterEach, expect, test, vi } from 'vitest';
import * as fileWatcher from '../../../server/src/file-watcher.ts';
import * as headWatcher from '../../../server/src/head-watcher.ts';
import { resetMetrics } from '../../../server/src/metrics.ts';
import * as parcelSubscription from '../../../server/src/parcel-subscription.ts';
import { runTeardownPhases } from '../stress/_helpers/teardown-fs.ts';
import {
  createTestClient,
  createTestServer,
  type TestClient,
  type TestServer,
} from './test-harness.ts';

const cleanups: Array<() => Promise<void>> = [];
const LOSS_NOTICE = 'Events were dropped by the FSEvents client. File system must be re-scanned.';

afterEach(async () => {
  await runTeardownPhases(...cleanups.splice(0).reverse());
});

async function scenario(mode: 'connection' | 'writer' | 'buffer') {
  resetMetrics();
  const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-recovery-adoption-')));
  const docName = `adoption-${randomUUID()}`;
  const filePath = join(contentDir, `${docName}.md`);
  const nativeCaptured = Promise.withResolvers<void>();
  const nativeRelease = Promise.withResolvers<void>();
  const handlerCaptured = Promise.withResolvers<void>();
  const handlerRelease = Promise.withResolvers<void>();
  const batchCaptured = Promise.withResolvers<void>();
  const batchRelease = Promise.withResolvers<void>();
  const batchFinished = Promise.withResolvers<void>();
  const work: Promise<void>[] = [];
  const clients: TestClient[] = [];
  const closed = new WeakSet<TestClient>();
  let armed = false;
  let recovery: Promise<void> | undefined;
  let server: TestServer | undefined;
  let recover: (() => Promise<void>) | undefined;
  let beginBatch: (() => Promise<void>) | undefined;
  let delivered = 0;
  const subscribe = parcelSubscription.subscribeParcel;
  const subscriptionSpy = vi
    .spyOn(parcelSubscription, 'subscribeParcel')
    .mockImplementation((parcel, dir, onEvents, options, platform) => {
      if (dir === contentDir)
        recover = async () => {
          await onEvents(new Error(LOSS_NOTICE), []);
        };
      if (dir === join(contentDir, '.git'))
        beginBatch = async () => {
          await onEvents(new Error(LOSS_NOTICE), []);
        };
      return subscribe(
        parcel,
        dir,
        (error, events) => {
          if (dir !== contentDir || !armed) return onEvents(error, events);
          if (events.some((event) => event.type === 'delete' && event.path === filePath))
            nativeCaptured.resolve();
          const pending = nativeRelease.promise.then(async () => {
            await onEvents(error, events);
          });
          work.push(pending);
          return pending;
        },
        options,
        platform,
      );
    });
  const startWatcher = fileWatcher.startWatcher;
  const watcherSpy = vi
    .spyOn(fileWatcher, 'startWatcher')
    .mockImplementation((root, onDiskEvent, filter, options) =>
      startWatcher(
        root,
        async (event) => {
          if (armed && event.kind === 'delete' && event.docName === docName) {
            handlerCaptured.resolve();
            if (mode !== 'buffer') await handlerRelease.promise;
          }
          await onDiskEvent(event);
          if (armed && event.kind === 'delete' && event.docName === docName) delivered += 1;
        },
        filter,
        { ...options, forceBackend: 'parcel' },
      ),
    );
  const startHeadWatcher = headWatcher.startHeadWatcher;
  const headSpy = vi
    .spyOn(headWatcher, 'startHeadWatcher')
    .mockImplementation((root, begin, end, options) =>
      startHeadWatcher(
        root,
        async (info) => {
          await begin(info);
          if (mode === 'buffer' && armed) {
            batchCaptured.resolve();
            await batchRelease.promise;
          }
        },
        async (info) => {
          await end(info);
          if (mode === 'buffer' && armed) batchFinished.resolve();
        },
        options,
      ),
    );
  cleanups.push(async () => {
    armed = false;
    batchRelease.resolve();
    handlerRelease.resolve();
    nativeRelease.resolve();
    await runTeardownPhases(
      async () => {
        await recovery;
        await Promise.all(work);
      },
      ...clients.map((client) => () => client.cleanup()),
      async () => {
        await server?.cleanup();
      },
      () => {
        headSpy.mockRestore();
        watcherSpy.mockRestore();
        subscriptionSpy.mockRestore();
      },
      () => rmSync(contentDir, { recursive: true, force: true }),
    );
  });
  writeFileSync(filePath, '# Original adoption page\n', { flag: 'wx' });
  server = await createTestServer({ contentDir });
  const running = server;
  const open = async () => {
    const client = await createTestClient(running.port, docName, { resetOnCleanup: false });
    clients.push(client);
    client.provider.on('close', () => closed.add(client));
    return client;
  };
  const initial = await open();
  expect(initial.ytext.toString()).toBe('# Original adoption page\n');
  armed = true;
  if (mode === 'buffer') {
    if (!beginBatch) throw new Error('Real head subscription not installed');
    await beginBatch();
    await batchCaptured.promise;
    expect(running.instance.durabilityState.isBatchInProgress()).toBe(true);
  }
  unlinkSync(filePath);
  await nativeCaptured.promise;
  if (!recover) throw new Error('Real content subscription not installed');
  recovery = recover();
  await handlerCaptured.promise;
  if (mode === 'buffer') {
    await recovery;
    expect(delivered).toBe(1);
    expect(running.instance.durabilityState.isBatchInProgress()).toBe(true);
  }
  const post = (route: string, body: unknown) =>
    fetch(`${running.baseUrl}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  expect((await post('/api/create-page', { path: `${docName}.md` })).status).toBe(200);
  const admitted = mode === 'writer' ? initial : await open();
  if (mode === 'writer') {
    expect(
      (
        await post('/api/agent-write-md', {
          docName,
          markdown: '# Written after recreation\n',
          position: 'replace',
          agentId: 'adoption-writer',
        })
      ).status,
    ).toBe(200);
    await expect.poll(() => admitted.ytext.toString()).toBe('# Written after recreation\n');
  }
  const resident = running.instance.hocuspocus.documents.get(docName);
  expect(resident).toBeDefined();
  const snapshot = async () => {
    const response = await fetch(`${running.baseUrl}/api/metrics/reconciliation`);
    expect(response.status).toBe(200);
    const metrics = MetricsReconciliationSuccessSchema.parse(await response.json());
    return {
      residentPreserved: running.instance.hocuspocus.documents.get(docName) === resident,
      clientClosed: closed.has(admitted),
      clientStatus: admitted.doc.getMap('lifecycle').get('status') ?? null,
      removedCount: metrics.recentlyRemovedDocsSize,
      disk: existsSync(filePath) ? readFileSync(filePath, 'utf8') : null,
    };
  };
  const before = await snapshot();
  expect(before).toMatchObject({
    residentPreserved: true,
    clientClosed: false,
    clientStatus: null,
    removedCount: 0,
  });
  if (mode === 'buffer') {
    expect(running.instance.durabilityState.isBatchInProgress()).toBe(true);
    batchRelease.resolve();
    await batchFinished.promise;
    expect(running.instance.durabilityState.isBatchInProgress()).toBe(false);
  } else {
    handlerRelease.resolve();
    await recovery;
  }
  expect(await snapshot()).toEqual(before);
}

test('a fresh connection without a write adopts recreation before recovery deletion', () =>
  scenario('connection'));

test('a direct writer without a new client adopts recreation before recovery deletion', () =>
  scenario('writer'));

test('recreation admitted after recovery completes survives the later head-batch drain', () =>
  scenario('buffer'));
