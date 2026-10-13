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
import { afterEach, expect, test, vi } from 'vitest';
import * as templateWrites from '../../../server/src/content/templates-write.ts';
import * as fileWatcher from '../../../server/src/file-watcher.ts';
import * as parcelSubscription from '../../../server/src/parcel-subscription.ts';
import { runTeardownPhases } from '../stress/_helpers/teardown-fs.ts';
import {
  createTestClient,
  createTestServer,
  type TestClient,
  type TestServer,
} from './test-harness.ts';

const SOURCE = '---\ntemplate:\n  title: Before move\n---\n\n# Template body\n';
const UPDATED = '---\ntemplate:\n  title: After move\n---\n\n# Template body\n';
const OLD_DESTINATION = '# Old destination\n';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await runTeardownPhases(...cleanups.splice(0).reverse());
});

type MetadataChange = 'updated' | 'absent' | 'refused';
type DestinationState = 'fresh' | 'obsolete';
type ResidentPair = { source: Document | undefined; destination: Document | undefined };

async function startTemplateMoveScenario(
  destinationState: DestinationState,
  metadataChange: MetadataChange,
) {
  const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-stale-template-move-')));
  const fromName = 'source/.ok/templates/before';
  const toName = 'destination/.ok/templates/after';
  const fromPath = join(contentDir, `${fromName}.md`);
  const toPath = join(contentDir, `${toName}.md`);
  mkdirSync(join(contentDir, 'source', '.ok', 'templates'), { recursive: true });
  mkdirSync(join(contentDir, 'destination', '.ok', 'templates'), { recursive: true });
  writeFileSync(fromPath, SOURCE, { flag: 'wx' });
  writeFileSync(toPath, OLD_DESTINATION, { flag: 'wx' });
  const deleted = Promise.withResolvers<void>();
  const releaseDelete = Promise.withResolvers<void>();
  const deleteCompleted = Promise.withResolvers<void>();
  const followers = Promise.withResolvers<void>();
  const moved = Promise.withResolvers<void>();
  const releaseMove = Promise.withResolvers<void>();
  const clients: TestClient[] = [];
  const restores: Array<() => void> = [];
  let sawDelete = false;
  let rawTail = Promise.resolve();
  let server: TestServer | undefined;
  let pendingMove: Promise<Response> | undefined;
  let moveStart: ResidentPair | undefined;
  let moveCompleted: ResidentPair | undefined;
  let clientClosed = false;

  const subscribe = parcelSubscription.subscribeParcel;
  const subscriptionSpy = vi
    .spyOn(parcelSubscription, 'subscribeParcel')
    .mockImplementation((parcel, dir, onEvents, options, platform) =>
      subscribe(
        parcel,
        dir,
        (error, events) => {
          if (!dir.startsWith(contentDir)) return onEvents(error, events);
          const selected =
            !sawDelete && events.some((event) => event.type === 'delete' && event.path === toPath);
          const follower = sawDelete;
          if (selected) sawDelete = true;
          const work = rawTail.then(async () => {
            if (follower) await followers.promise;
            await onEvents(error, events);
            if (selected) deleteCompleted.resolve();
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
          if (event.kind === 'delete' && event.docName === toName) {
            deleted.resolve();
            await releaseDelete.promise;
          }
          await onDiskEvent(event);
        },
        filter,
        { ...options, forceBackend: 'parcel' },
      ),
    );
  restores.push(() => watcherSpy.mockRestore());
  const move = templateWrites.applyTemplateMove;
  const moveSpy = vi
    .spyOn(templateWrites, 'applyTemplateMove')
    .mockImplementation(async (input) => {
      if (input.projectDir !== contentDir) return move(input);
      moveStart = {
        source: server?.instance.hocuspocus.documents.get(fromName),
        destination: server?.instance.hocuspocus.documents.get(toName),
      };
      const result = await move(input);
      if (result.ok) {
        moveCompleted = {
          source: server?.instance.hocuspocus.documents.get(fromName),
          destination: server?.instance.hocuspocus.documents.get(toName),
        };
        moved.resolve();
        await releaseMove.promise;
      }
      return result;
    });
  restores.push(() => moveSpy.mockRestore());

  cleanups.push(async () => {
    releaseDelete.resolve();
    releaseMove.resolve();
    followers.resolve();
    await runTeardownPhases(
      async () => {
        await pendingMove;
      },
      () => rawTail,
      ...clients.map((client) => () => client.cleanup()),
      async () => {
        await server?.cleanup();
      },
      () => {
        for (const restore of restores.reverse()) restore();
      },
      () => rmSync(contentDir, { recursive: true, force: true }),
    );
  });

  server = await createTestServer({ contentDir });
  const running = server;
  const source = await createTestClient(running.port, fromName, { resetOnCleanup: false });
  clients.push(source);
  const sourceResident = running.instance.hocuspocus.documents.get(fromName);
  expect(sourceResident).toBeDefined();
  expect(source.ytext.toString()).toBe(SOURCE);
  let destination: TestClient | undefined;
  if (destinationState === 'obsolete') {
    destination = await createTestClient(running.port, toName, { resetOnCleanup: false });
    clients.push(destination);
    expect(destination.ytext.toString()).toBe(OLD_DESTINATION);
  }
  const priorDestination = running.instance.hocuspocus.documents.get(toName);
  if (destinationState === 'fresh') expect(priorDestination).toBeUndefined();
  else expect(priorDestination).toBeDefined();
  unlinkSync(toPath);
  await deleted.promise;

  const metadata =
    metadataChange === 'absent'
      ? {}
      : { frontmatter: { title: metadataChange === 'updated' ? 'After move' : '' } };
  pendingMove = fetch(`${running.baseUrl}/api/template`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fromFolder: 'source',
      fromName: 'before',
      toFolder: 'destination',
      toName: 'after',
      ...metadata,
    }),
  });
  await moved.promise;
  expect(moveStart).toBeDefined();
  expect(moveCompleted).toBeDefined();
  expect(moveStart?.source).toBeUndefined();
  expect(moveCompleted?.source).toBeUndefined();
  expect(moveStart?.destination).toBe(priorDestination);
  expect(moveCompleted?.destination).toBe(priorDestination);
  expect(running.instance.hocuspocus.documents.has(fromName)).toBe(false);
  expect(existsSync(fromPath)).toBe(false);
  expect(readFileSync(toPath, 'utf8')).toBe(SOURCE);

  if (destinationState === 'fresh') {
    destination = await createTestClient(running.port, toName, { resetOnCleanup: false });
    clients.push(destination);
  }
  if (!destination) throw new Error('Destination client was not admitted');
  destination.provider.on('close', () => {
    clientClosed = true;
  });
  const destinationResident = running.instance.hocuspocus.documents.get(toName);
  expect(destinationResident).toBeDefined();
  expect(destinationResident).not.toBe(sourceResident);
  if (destinationState === 'fresh') expect(destinationResident).not.toBe(priorDestination);
  else expect(destinationResident).toBe(priorDestination);
  const residentBytes = destinationState === 'fresh' ? SOURCE : OLD_DESTINATION;
  expect(destination.ytext.toString()).toBe(residentBytes);
  releaseMove.resolve();
  const response = await pendingMove;
  const responseBody: unknown = await response.json();
  if (metadataChange === 'refused') {
    expect(response.status).toBe(400);
    expect(responseBody).toMatchObject({
      type: 'urn:ok:error:invalid-request',
      detail: 'TEMPLATE_TITLE_REQUIRED',
    });
  } else {
    expect(response.status, JSON.stringify(responseBody)).toBe(200);
    expect(responseBody).toMatchObject({
      from: 'source/.ok/templates/before.md',
      to: 'destination/.ok/templates/after.md',
    });
  }
  const published = metadataChange === 'updated' ? UPDATED : SOURCE;
  expect(readFileSync(toPath, 'utf8')).toBe(published);
  expect(running.instance.hocuspocus.documents.get(toName)).toBe(destinationResident);
  expect(destinationResident?.getText('source').toString()).toBe(residentBytes);
  expect(clientClosed).toBe(false);

  return {
    async finishDeletion() {
      releaseDelete.resolve();
      await deleteCompleted.promise;
      return {
        residentPreserved:
          running.instance.hocuspocus.documents.get(toName) === destinationResident,
        lifecycleStatus: destinationResident?.getMap('lifecycle').get('status') ?? null,
        residentContent: destinationResident?.getText('source').toString() ?? null,
        clientClosed,
        disk: readFileSync(toPath, 'utf8'),
      };
    },
  };
}

test.each([
  ['metadata succeeds', 'updated', UPDATED],
  ['metadata is omitted', 'absent', SOURCE],
  ['metadata is refused after placement', 'refused', SOURCE],
] as const)(
  'a moved template keeps its newly admitted destination after an older delete when %s',
  async (_label, metadataChange, expectedDisk) => {
    const scenario = await startTemplateMoveScenario('fresh', metadataChange);
    expect(await scenario.finishDeletion()).toEqual({
      residentPreserved: true,
      lifecycleStatus: null,
      residentContent: SOURCE,
      clientClosed: false,
      disk: expectedDisk,
    });
  },
);

test('a moved template retires the unchanged old destination resident after an older delete', async () => {
  const scenario = await startTemplateMoveScenario('obsolete', 'updated');
  expect(await scenario.finishDeletion()).toMatchObject({
    residentPreserved: false,
    lifecycleStatus: 'deleted-upstream',
    residentContent: OLD_DESTINATION,
    disk: UPDATED,
  });
});
