import { unlinkSync, writeFileSync } from 'node:fs';
import type { Extension } from '@hocuspocus/server';
import { afterEach, expect, test } from 'vitest';
import { runTeardownPhases } from '../stress/_helpers/teardown-fs.ts';
import { startDeletionScenario } from './stale-delete-recreation.test-helper.ts';
import { startAssetAdmissionScenario } from './stale-removal-coverage.test-helper.ts';

const cleanups: Array<() => Promise<void> | void> = [];
const registerCleanup = (cleanup: () => Promise<void> | void) => {
  cleanups.push(cleanup);
};

afterEach(async () => {
  await runTeardownPhases(...cleanups.splice(0).reverse());
});

test('a stale native deletion preserves sibling asset admission after external recreation', async () => {
  const scenario = await startAssetAdmissionScenario(registerCleanup);
  expect((await scenario.snapshot()).assetAdmitted).toBe(true);
  unlinkSync(scenario.filePath);
  const deletion = await scenario.nextBatch('delete');
  writeFileSync(scenario.filePath, '# Recreated Markdown\n');
  deletion.release();
  await deletion.completed;
  const after = await scenario.snapshot();
  expect(after.assetAdmitted).toBe(true);
  expect(after).toMatchObject({ disk: '# Recreated Markdown\n', indexed: true });
});

test('deleting the last Markdown removes sibling asset admission', async () => {
  const scenario = await startAssetAdmissionScenario(registerCleanup);
  expect((await scenario.snapshot()).assetAdmitted).toBe(true);
  unlinkSync(scenario.filePath);
  const deletion = await scenario.nextBatch('delete');
  deletion.release();
  await deletion.completed;
  expect(await scenario.snapshot()).toEqual({ disk: null, indexed: false, assetAdmitted: false });
});

test('an API recreation and final deletion leave sibling asset counts balanced', async () => {
  const scenario = await startAssetAdmissionScenario(registerCleanup);
  expect((await scenario.snapshot()).assetAdmitted).toBe(true);
  await scenario.deleteThroughApi();
  const oldDeletion = await scenario.nextBatch('delete');
  await scenario.createThroughApi();
  const recreation = await scenario.nextBatch('write');
  oldDeletion.release();
  await oldDeletion.completed;
  expect((await scenario.snapshot()).assetAdmitted).toBe(true);
  recreation.release();
  await recreation.completed;
  expect(await scenario.snapshot()).toEqual({ disk: '', indexed: true, assetAdmitted: true });

  await scenario.deleteThroughApi();
  const finalDeletion = await scenario.nextBatch('delete');
  expect(finalDeletion).not.toBe(oldDeletion);
  finalDeletion.release();
  await finalDeletion.completed;
  expect(await scenario.snapshot()).toEqual({ disk: null, indexed: false, assetAdmitted: false });
});

test('a recreation admitted during the final unload hook survives the older removal', async () => {
  const scenario = await startDeletionScenario('none', registerCleanup);
  await scenario.open();
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let held = false;
  const extension: Extension = {
    async beforeUnloadDocument({ documentName }) {
      if (documentName !== scenario.docName || held) return;
      held = true;
      reached.resolve();
      await release.promise;
    },
  };
  const extensions = scenario.server.instance.hocuspocus.configuration.extensions;
  extensions.push(extension);
  registerCleanup(() => {
    const index = extensions.indexOf(extension);
    if (index !== -1) extensions.splice(index, 1);
  });
  registerCleanup(() => release.resolve());
  scenario.deleteExternally();
  await reached.promise;
  const response = await fetch(`${scenario.server.baseUrl}/api/create-page`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: `${scenario.docName}.md` }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ docName: scenario.docName });
  const fresh = await scenario.open();
  expect(await scenario.snapshot(fresh)).toMatchObject({
    disk: '',
    residentPresent: true,
    lifecycleStatus: null,
    clientLifecycleStatus: null,
    clientClosed: false,
    removedCount: 0,
    listed: true,
  });

  release.resolve();
  await scenario.finishDeletion();
  expect(await scenario.snapshot(fresh)).toMatchObject({
    disk: '',
    residentPresent: true,
    lifecycleStatus: null,
    clientLifecycleStatus: null,
    clientClosed: false,
    removedCount: 0,
    listed: true,
  });
});
