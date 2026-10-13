import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { runTeardownPhases } from '../stress/_helpers/teardown-fs.ts';
import {
  ORIGINAL,
  RECREATED,
  startDeletionScenario,
} from './stale-delete-recreation.test-helper.ts';

const nativeWriteObservation = vi.hoisted(
  (): {
    current?: {
      directory: string;
      path: string;
      consumed: PromiseWithResolvers<void>;
    };
  } => ({}),
);

vi.mock('../../../server/src/parcel-subscription.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../server/src/parcel-subscription.ts')>();
  const subscribe = actual.subscribeParcel;
  return {
    ...actual,
    subscribeParcel: (...args: Parameters<typeof subscribe>) => {
      const [parcel, directory, callback, options, platform] = args;
      return subscribe(
        parcel,
        directory,
        (error, events) => {
          const observation = nativeWriteObservation.current;
          const selected =
            observation !== undefined &&
            observation.directory === directory &&
            events.some(
              (event) =>
                event.path === observation.path &&
                (event.type === 'create' || event.type === 'update'),
            );
          const result = callback(error, events);
          if (selected) {
            void Promise.resolve(result).then(
              () => observation.consumed.resolve(),
              (cause: unknown) => observation.consumed.reject(cause),
            );
          }
          return result;
        },
        options,
        platform,
      );
    },
  };
});

const cleanups: Array<() => Promise<void>> = [];
const registerCleanup = (cleanup: () => Promise<void>) => cleanups.push(cleanup);

afterEach(async () => {
  nativeWriteObservation.current = undefined;
  await runTeardownPhases(...cleanups.splice(0).reverse());
});

test('external deletion followed by creation keeps only the recreated page comments', async () => {
  const scenario = await startDeletionScenario('classified', registerCleanup);
  const original = await scenario.open();
  expect(original.ytext.toString()).toBe(ORIGINAL);
  const oldThread = await scenario.comment('Original page');
  expect((await scenario.snapshot(original)).threads).toEqual([oldThread.threadId]);
  scenario.deleteExternally();
  await scenario.waitUntilHeld();
  const fresh = await scenario.create();
  const newThread = await scenario.comment('Recreated page');
  expect((await scenario.snapshot(fresh)).threads).toContain(newThread.threadId);
  await scenario.finishDeletion();
  expect(await scenario.snapshot(fresh)).toMatchObject({
    disk: RECREATED,
    residentPresent: true,
    clientClosed: false,
    removedCount: 0,
    threads: [newThread.threadId],
  });
});

test('a successful write and index registration retain the current page comments', async () => {
  const scenario = await startDeletionScenario('none', registerCleanup);
  const client = await scenario.open();
  const thread = await scenario.comment('Original page');
  expect((await scenario.snapshot(client)).threads).toEqual([thread.threadId]);
  const response = await fetch(`${scenario.server.baseUrl}/api/agent-write-md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      docName: scenario.docName,
      markdown: RECREATED,
      position: 'replace',
      agentId: 'comment-control',
    }),
  });
  expect(response.status).toBe(200);
  await expect.poll(() => client.ytext.toString()).toBe(RECREATED);
  expect(await scenario.snapshot(client)).toMatchObject({
    disk: RECREATED,
    residentPresent: true,
    threads: [thread.threadId],
  });
});

test('an older write completion cannot adopt the unmodified resident of a recreated page', async () => {
  const scenario = await startDeletionScenario('classified', registerCleanup);
  const client = await scenario.open();
  expect(client.ytext.toString()).toBe(ORIGINAL);
  const oldResident = scenario.server.instance.hocuspocus.documents.get(scenario.docName);
  expect(oldResident).toBeDefined();
  const oldWritten = '# Accepted before recreation\n';
  const replacement = '# Replacement without resident adoption\n';
  const templateDir = join(scenario.server.contentDir, '.ok', 'templates');
  mkdirSync(templateDir, { recursive: true });
  writeFileSync(join(templateDir, 'replacement.md'), replacement, { flag: 'wx' });
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const durability = scenario.server.instance.durabilityState;
  const originalOutcome = durability.awaitDeferredStoreOutcome.bind(durability);
  let captured = false;
  const spy = vi.spyOn(durability, 'awaitDeferredStoreOutcome').mockImplementation(async (name) => {
    const result = await originalOutcome(name);
    if (name === scenario.docName && !captured) {
      captured = true;
      reached.resolve();
      await release.promise;
    }
    return result;
  });
  const canonicalWriteConsumed = Promise.withResolvers<void>();
  void canonicalWriteConsumed.promise.catch(() => {});
  nativeWriteObservation.current = {
    directory: scenario.server.contentDir,
    path: join(scenario.server.contentDir, `${scenario.docName}.md`),
    consumed: canonicalWriteConsumed,
  };
  const pendingWrite = fetch(`${scenario.server.baseUrl}/api/agent-write-md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      docName: scenario.docName,
      markdown: oldWritten,
      position: 'replace',
      agentId: 'obsolete-writer',
    }),
  });
  registerCleanup(async () => {
    release.resolve();
    await pendingWrite;
    spy.mockRestore();
  });
  await reached.promise;
  const filePath = join(scenario.server.contentDir, `${scenario.docName}.md`);
  expect(readFileSync(filePath, 'utf8')).toBe(oldWritten);
  expect(oldResident?.getText('source').toString()).toBe(oldWritten);
  await canonicalWriteConsumed.promise;
  scenario.deleteExternally();
  await scenario.waitUntilHeld();
  const created = await fetch(`${scenario.server.baseUrl}/api/create-page`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: `${scenario.docName}.md`, template: 'replacement' }),
  });
  expect(created.status).toBe(200);
  expect(readFileSync(filePath, 'utf8')).toBe(replacement);
  expect(oldResident?.getText('source').toString()).toBe(oldWritten);
  release.resolve();
  expect((await pendingWrite).status).toBe(200);
  await scenario.finishDeletion();
  expect(scenario.server.instance.hocuspocus.documents.get(scenario.docName)).not.toBe(oldResident);
  expect(readFileSync(filePath, 'utf8')).toBe(replacement);
  expect((await scenario.readDocument()).content).toBe(replacement);
});
