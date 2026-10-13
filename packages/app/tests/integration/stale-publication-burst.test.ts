import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import * as fsTraced from '../../../server/src/fs-traced.ts';
import { runTeardownPhases } from '../stress/_helpers/teardown-fs.ts';
import { ORIGINAL, startDeletionScenario } from './stale-delete-recreation.test-helper.ts';

const FIRST_APPEND = '\nFirst published edit after recreation.\n';
const SECOND_APPEND = '\nLater edit awaiting publication.\n';
const FIRST_CONTENT = ORIGINAL + FIRST_APPEND;
const SECOND_CONTENT = FIRST_CONTENT + SECOND_APPEND;
const cleanups: Array<() => Promise<void>> = [];
const registerCleanup = (cleanup: () => Promise<void>) => cleanups.push(cleanup);

afterEach(async () => {
  await runTeardownPhases(...cleanups.splice(0).reverse());
});

test('a published edit preserves its recreated lifetime while a later edit is still awaiting publication', async () => {
  const scenario = await startDeletionScenario('classified', registerCleanup);
  const client = await scenario.open();
  expect(client.ytext.toString()).toBe(ORIGINAL);
  const resident = scenario.server.instance.hocuspocus.documents.get(scenario.docName);
  if (!resident) throw new Error('Expected the original connected resident');
  const filePath = join(scenario.server.contentDir, `${scenario.docName}.md`);
  const templates = join(scenario.server.contentDir, '.ok', 'templates');

  scenario.deleteExternally();
  await scenario.waitUntilHeld();
  mkdirSync(templates, { recursive: true });
  writeFileSync(join(templates, 'same-before-burst.md'), ORIGINAL, { flag: 'wx' });
  const created = await fetch(`${scenario.server.baseUrl}/api/create-page`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: `${scenario.docName}.md`, template: 'same-before-burst' }),
  });
  expect(created.status).toBe(200);
  expect(await created.json()).toEqual({ docName: scenario.docName });
  expect(readFileSync(filePath, 'utf8')).toBe(ORIGINAL);
  expect(scenario.server.instance.hocuspocus.documents.get(scenario.docName)).toBe(resident);

  const firstEntered = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const secondEntered = Promise.withResolvers<void>();
  const releaseSecond = Promise.withResolvers<void>();
  const pendingWrites = new Set<Promise<void>>();
  const write = fsTraced.tracedWriteFile;
  let firstHeld = false;
  let secondHeld = false;
  const writeSpy = vi.spyOn(fsTraced, 'tracedWriteFile').mockImplementation((...args) => {
    const work = (async () => {
      await write(...args);
      if (!String(args[0]).startsWith(`${filePath}.tmp.`)) return;
      if (args[1] === FIRST_CONTENT && !firstHeld) {
        firstHeld = true;
        firstEntered.resolve();
        await releaseFirst.promise;
      } else if (args[1] === SECOND_CONTENT && !secondHeld) {
        secondHeld = true;
        secondEntered.resolve();
        await releaseSecond.promise;
      }
    })();
    pendingWrites.add(work);
    void work.then(
      () => pendingWrites.delete(work),
      () => pendingWrites.delete(work),
    );
    return work;
  });
  registerCleanup(async () => {
    releaseFirst.resolve();
    releaseSecond.resolve();
    await Promise.allSettled(pendingWrites);
    writeSpy.mockRestore();
  });

  client.doc.transact(() => client.ytext.insert(client.ytext.length, FIRST_APPEND));
  await firstEntered.promise;
  expect(resident.getText('source').toString()).toBe(FIRST_CONTENT);
  expect(readFileSync(filePath, 'utf8')).toBe(ORIGINAL);

  client.doc.transact(() => client.ytext.insert(client.ytext.length, SECOND_APPEND));
  await expect.poll(() => resident.getText('source').toString()).toBe(SECOND_CONTENT);
  expect(scenario.server.instance.hocuspocus.documents.get(scenario.docName)).toBe(resident);
  releaseFirst.resolve();
  await secondEntered.promise;
  expect(readFileSync(filePath, 'utf8')).toBe(FIRST_CONTENT);
  expect(resident.getText('source').toString()).toBe(SECOND_CONTENT);
  expect(resident.isDestroyed).toBe(false);

  await scenario.finishDeletion();
  expect({
    residentPreserved:
      scenario.server.instance.hocuspocus.documents.get(scenario.docName) === resident,
    destroyed: resident.isDestroyed,
    lifecycleStatus: resident.getMap('lifecycle').get('status') ?? null,
    residentContent: resident.getText('source').toString(),
    clientContent: client.ytext.toString(),
    disk: readFileSync(filePath, 'utf8'),
  }).toEqual({
    residentPreserved: true,
    destroyed: false,
    lifecycleStatus: null,
    residentContent: SECOND_CONTENT,
    clientContent: SECOND_CONTENT,
    disk: FIRST_CONTENT,
  });

  releaseSecond.resolve();
  await expect.poll(() => readFileSync(filePath, 'utf8')).toBe(SECOND_CONTENT);
  expect(scenario.server.instance.hocuspocus.documents.get(scenario.docName)).toBe(resident);
});
