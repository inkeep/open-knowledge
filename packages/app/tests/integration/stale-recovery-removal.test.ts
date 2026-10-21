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
import {
  MetricsReconciliationSuccessSchema,
  PagesSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { afterEach, expect, test, vi } from 'vitest';
import * as fileWatcher from '../../../server/src/file-watcher.ts';
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
const ORIGINAL = '# Original recovery page\n';
const RECREATED = '# Recreated recovery page\n';
const LOSS_NOTICE = 'Events were dropped by the FSEvents client. File system must be re-scanned.';

afterEach(async () => {
  await runTeardownPhases(...cleanups.splice(0).reverse());
});

async function recoveryScenario(recreate: boolean) {
  resetMetrics();
  const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-recovery-removal-')));
  const docName = `recovery-${randomUUID()}`;
  const filePath = join(contentDir, `${docName}.md`);
  const nativeCaptured = Promise.withResolvers<void>();
  const nativeRelease = Promise.withResolvers<void>();
  const handlerCaptured = Promise.withResolvers<void>();
  const handlerRelease = Promise.withResolvers<void>();
  const clients: TestClient[] = [];
  const closedClients = new WeakSet<TestClient>();
  const nativeWork: Promise<void>[] = [];
  let server: TestServer | undefined;
  let armed = false;
  let recovery: Promise<void> | undefined;
  let recover: (() => Promise<void>) | undefined;
  const subscribe = parcelSubscription.subscribeParcel;
  const subscriptionSpy = vi
    .spyOn(parcelSubscription, 'subscribeParcel')
    .mockImplementation((parcel, dir, onEvents, options, platform) => {
      if (dir === contentDir) {
        recover = async () => {
          await onEvents(new Error(LOSS_NOTICE), []);
        };
      }
      return subscribe(
        parcel,
        dir,
        (error, events) => {
          if (dir !== contentDir || !armed) return onEvents(error, events);
          if (events.some((event) => event.type === 'delete' && event.path === filePath))
            nativeCaptured.resolve();
          const work = nativeRelease.promise.then(async () => {
            await onEvents(error, events);
          });
          nativeWork.push(work);
          return work;
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
            await handlerRelease.promise;
          }
          await onDiskEvent(event);
        },
        filter,
        { ...options, forceBackend: 'parcel' },
      ),
    );
  cleanups.push(async () => {
    armed = false;
    handlerRelease.resolve();
    nativeRelease.resolve();
    await runTeardownPhases(
      async () => {
        await recovery;
        await Promise.all(nativeWork);
      },
      ...clients.map((client) => () => client.cleanup()),
      async () => {
        await server?.cleanup();
      },
      () => {
        watcherSpy.mockRestore();
        subscriptionSpy.mockRestore();
      },
      () => rmSync(contentDir, { recursive: true, force: true }),
    );
  });

  writeFileSync(filePath, ORIGINAL, { flag: 'wx' });
  server = await createTestServer({ contentDir });
  const running = server;
  const open = async () => {
    const client = await createTestClient(running.port, docName, { resetOnCleanup: false });
    clients.push(client);
    client.provider.on('close', () => closedClients.add(client));
    return client;
  };
  const post = (route: string, body: unknown) =>
    fetch(`${running.baseUrl}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const snapshot = async (client: TestClient) => {
    const resident = running.instance.hocuspocus.documents.get(docName);
    const metricsResponse = await fetch(`${running.baseUrl}/api/metrics/reconciliation`);
    const pagesResponse = await fetch(`${running.baseUrl}/api/pages`);
    expect([metricsResponse.status, pagesResponse.status]).toEqual([200, 200]);
    const metrics = MetricsReconciliationSuccessSchema.parse(await metricsResponse.json());
    const pages = PagesSuccessSchema.parse(await pagesResponse.json());
    return {
      disk: existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null,
      resident,
      residentContent: resident?.getText('source').toString() ?? null,
      lifecycleStatus: resident?.getMap('lifecycle').get('status') ?? null,
      clientContent: client.ytext.toString(),
      clientLifecycleStatus: client.doc.getMap('lifecycle').get('status') ?? null,
      clientClosed: closedClients.has(client),
      removedCount: metrics.recentlyRemovedDocsSize,
      listed: pages.pages.some((page) => page.docName === docName),
    };
  };
  const initial = await open();
  expect(initial.ytext.toString()).toBe(ORIGINAL);
  armed = true;
  unlinkSync(filePath);
  await nativeCaptured.promise;
  if (!recover) throw new Error('Owned Parcel subscription was not established');
  recovery = recover();
  await handlerCaptured.promise;

  if (recreate) {
    const created = await post('/api/create-page', { path: `${docName}.md` });
    expect(created.status).toBe(200);
    const fresh = await open();
    const written = await post('/api/agent-write-md', {
      docName,
      markdown: RECREATED,
      position: 'replace',
      agentId: 'recovery-recreation',
    });
    expect(written.status).toBe(200);
    await expect.poll(() => fresh.ytext.toString()).toBe(RECREATED);
    const { resident: admitted, ...before } = await snapshot(fresh);
    expect(admitted).toBeDefined();
    expect(before).toEqual({
      disk: RECREATED,
      residentContent: RECREATED,
      lifecycleStatus: null,
      clientContent: RECREATED,
      clientLifecycleStatus: null,
      clientClosed: false,
      removedCount: 0,
      listed: true,
    });

    handlerRelease.resolve();
    await recovery;
    const { resident, ...after } = await snapshot(fresh);
    expect({ residentPreserved: resident === admitted, ...after }).toEqual({
      residentPreserved: true,
      ...before,
    });
  } else {
    handlerRelease.resolve();
    await recovery;
    await expect
      .poll(() => running.instance.hocuspocus.documents.has(docName), { timeout: 10_000 })
      .toBe(false);
    const { resident, ...after } = await snapshot(initial);
    expect({ residentPresent: resident !== undefined, ...after }).toMatchObject({
      disk: null,
      residentPresent: false,
      residentContent: null,
      removedCount: 1,
      listed: false,
    });
  }
}

test('loss-notice recovery preserves a recreation accepted before deletion delivery', () =>
  recoveryScenario(true));

test('loss-notice recovery removes a genuinely deleted page', () => recoveryScenario(false));
