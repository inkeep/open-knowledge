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
import { HocuspocusProvider } from '@hocuspocus/provider';
import {
  MetricsReconciliationSuccessSchema,
  PagesSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { afterEach, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import * as fileWatcher from '../../../server/src/file-watcher.ts';
import { resetMetrics } from '../../../server/src/metrics.ts';
import * as parcelSubscription from '../../../server/src/parcel-subscription.ts';
import { parseCC1DiskAck, SYSTEM_DOC_NAME } from '../../src/lib/cc1.ts';
import { runTeardownPhases } from '../stress/_helpers/teardown-fs.ts';
import {
  createTestClient,
  createTestServer,
  type TestClient,
  type TestServer,
  waitForSync,
} from './test-harness.ts';

const ORIGINAL = '# Original WS page\n\nOriginal body.\n';
const APPEND = '\nConnected edit after recreation.\n';
const EDITED = ORIGINAL + APPEND;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await runTeardownPhases(...cleanups.splice(0).reverse());
});

test('an already-connected WebSocket edit acknowledged on disk survives a delayed native deletion', async () => {
  resetMetrics();
  const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-ws-delete-adoption-')));
  const docName = `connected-${randomUUID()}`;
  const filePath = join(contentDir, `${docName}.md`);
  const entered = Promise.withResolvers<void>();
  const deliver = Promise.withResolvers<void>();
  const followers = Promise.withResolvers<void>();
  const batchFinished = Promise.withResolvers<void>();
  const diskAck = Promise.withResolvers<{
    payload: string;
    stateVector: Array<[number, number]>;
    disk: string;
  }>();
  let server: TestServer | undefined;
  let originalClient: TestClient | undefined;
  let systemProvider: HocuspocusProvider | undefined;
  let systemDoc: Y.Doc | undefined;
  let rawTail = Promise.resolve();
  let selectedDeleteSeen = false;
  let handlerHeld = false;
  let clientClosed = false;
  let closing = false;
  let desiredVector: Map<number, number> | undefined;
  let editIssued = false;

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
          if (selected) {
            selectedDeleteSeen = true;
          }
          const work = rawTail.then(async () => {
            if (follower) await followers.promise;
            await onEvents(error, events);
            if (selected) batchFinished.resolve();
          });
          rawTail = work;
          return work;
        },
        options,
        platform,
      ),
    );
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
            await deliver.promise;
          }
          await onDiskEvent(event);
        },
        filter,
        { ...options, forceBackend: 'parcel' },
      ),
    );

  cleanups.push(async () => {
    closing = true;
    deliver.resolve();
    followers.resolve();
    await runTeardownPhases(
      () => rawTail,
      async () => {
        await originalClient?.cleanup();
      },
      () => {
        systemProvider?.destroy();
        systemDoc?.destroy();
      },
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
  mkdirSync(join(contentDir, '.ok', 'templates'), { recursive: true });
  writeFileSync(join(contentDir, '.ok', 'templates', 'same-original.md'), ORIGINAL, { flag: 'wx' });
  server = await createTestServer({ contentDir });
  const running = server;
  originalClient = await createTestClient(running.port, docName, { resetOnCleanup: false });
  const client = originalClient;
  client.provider.on('close', () => {
    clientClosed = true;
  });
  expect(client.ytext.toString()).toBe(ORIGINAL);
  expect(client.provider.isAuthenticated).toBe(true);

  systemDoc = new Y.Doc();
  systemProvider = new HocuspocusProvider({
    url: `${running.wsUrl}/collab`,
    name: SYSTEM_DOC_NAME,
    document: systemDoc,
    onStateless: ({ payload }: { payload: string }) => {
      if (closing) return;
      const ack = parseCC1DiskAck(payload);
      if (!ack || ack.docName !== docName) return;
      const vector = Y.decodeStateVector(ack.sv);
      const coversEdit =
        editIssued &&
        desiredVector !== undefined &&
        [...desiredVector].every(([id, clock]) => (vector.get(id) ?? 0) >= clock);
      const disk = existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
      if (coversEdit && disk === EDITED) {
        diskAck.resolve({ payload, stateVector: [...vector], disk });
      }
    },
  });
  await waitForSync(systemProvider);
  unlinkSync(filePath);
  await entered.promise;
  expect(selectedDeleteSeen).toBe(true);
  expect(existsSync(filePath)).toBe(false);
  expect(clientClosed).toBe(false);
  expect(client.provider.isAuthenticated).toBe(true);
  const created = await fetch(`${running.baseUrl}/api/create-page`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: `${docName}.md`, template: 'same-original' }),
  });
  const createdBody = await created.json();
  expect(created.status).toBe(200);
  expect(createdBody).toEqual({ docName });
  expect(readFileSync(filePath, 'utf8')).toBe(ORIGINAL);
  expect(client.ytext.toString()).toBe(ORIGINAL);
  expect(clientClosed).toBe(false);
  expect(client.provider.isAuthenticated).toBe(true);

  const beforeEditVector = Y.decodeStateVector(Y.encodeStateVector(client.doc));
  client.doc.transact(() => client.ytext.insert(client.ytext.length, APPEND));
  desiredVector = Y.decodeStateVector(Y.encodeStateVector(client.doc));
  editIssued = true;
  expect(desiredVector.get(client.doc.clientID) ?? 0).toBeGreaterThan(
    beforeEditVector.get(client.doc.clientID) ?? 0,
  );
  const acknowledged = await diskAck.promise;
  expect(acknowledged.disk).toBe(EDITED);
  expect(readFileSync(filePath, 'utf8')).toBe(EDITED);
  expect(client.ytext.toString()).toBe(EDITED);
  const savedResident = running.instance.hocuspocus.documents.get(docName);
  expect(savedResident).toBeDefined();
  expect(savedResident?.getText('source').toString()).toBe(EDITED);
  expect(savedResident?.getMap('lifecycle').get('status')).toBeUndefined();
  expect(clientClosed).toBe(false);

  const snapshot = async () => {
    const resident = running.instance.hocuspocus.documents.get(docName);
    const metricsResponse = await fetch(`${running.baseUrl}/api/metrics/reconciliation`);
    const pagesResponse = await fetch(`${running.baseUrl}/api/pages`);
    expect([metricsResponse.status, pagesResponse.status]).toEqual([200, 200]);
    const metrics = MetricsReconciliationSuccessSchema.parse(await metricsResponse.json());
    const pages = PagesSuccessSchema.parse(await pagesResponse.json());
    return {
      disk: existsSync(filePath) ? readFileSync(filePath, 'utf8') : null,
      residentPreserved: resident === savedResident,
      residentContent: resident?.getText('source').toString() ?? null,
      lifecycleStatus: resident?.getMap('lifecycle').get('status') ?? null,
      clientContent: client.ytext.toString(),
      clientLifecycleStatus: client.doc.getMap('lifecycle').get('status') ?? null,
      clientClosed,
      removedCount: metrics.recentlyRemovedDocsSize,
      listed: pages.pages.some((page) => page.docName === docName),
    };
  };
  const expected = {
    disk: EDITED,
    residentPreserved: true,
    residentContent: EDITED,
    lifecycleStatus: null,
    clientContent: EDITED,
    clientLifecycleStatus: null,
    clientClosed: false,
    removedCount: 0,
    listed: true,
  };
  const before = await snapshot();
  expect(before).toEqual(expected);
  deliver.resolve();
  await batchFinished.promise;
  const after = await snapshot();
  expect(after).toEqual(expected);
});
