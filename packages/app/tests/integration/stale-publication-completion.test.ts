import { afterEach, expect, test } from 'vitest';
import { runTeardownPhases } from '../stress/_helpers/teardown-fs.ts';
import {
  ORIGINAL_PUBLICATION,
  PENDING_PUBLICATION,
  startStalePublicationScenario,
} from './stale-publication-completion.test-helper.ts';

const cleanups: Array<() => Promise<void>> = [];
const registerCleanup = (cleanup: () => Promise<void>) => cleanups.push(cleanup);

afterEach(async () => {
  await runTeardownPhases(...cleanups.splice(0).reverse());
});

test('a publication captured before same-object recreation cannot adopt its unmodified lifetime', async () => {
  const scenario = await startStalePublicationScenario(registerCleanup);
  const originalClient = await scenario.open();
  expect(originalClient.ytext.toString()).toBe(ORIGINAL_PUBLICATION);
  const originalDocument = await scenario.startPendingWrite(originalClient);
  const deletion = scenario.armDeletion('classified');
  scenario.deleteExternally();
  await deletion.waitUntilHeld();
  await scenario.recreate();
  expect(scenario.resident()).toBe(originalDocument);
  expect(originalDocument.isDestroyed).toBe(false);
  expect(scenario.clientClosed(originalClient)).toBe(false);

  await scenario.finishPendingWrite();
  expect(scenario.resident()).toBe(originalDocument);
  expect(originalDocument.getText('source').toString()).toBe(PENDING_PUBLICATION);
  await deletion.finish();
  expect(originalDocument.isDestroyed, JSON.stringify(scenario.trace)).toBe(true);
  expect(scenario.resident()).not.toBe(originalDocument);
  expect(scenario.disk()).toBe(PENDING_PUBLICATION);
});

test('a publication from a replaced Document cannot adopt the replacement unmodified lifetime', async () => {
  const scenario = await startStalePublicationScenario(registerCleanup);
  const originalClient = await scenario.open();
  expect(originalClient.ytext.toString()).toBe(ORIGINAL_PUBLICATION);
  const originalDocument = await scenario.startPendingWrite(originalClient);
  const originalDeletion = scenario.armDeletion('none');
  await scenario.deleteThroughApi();
  expect(originalDocument.isDestroyed).toBe(true);
  await originalDeletion.finish(true);

  const replacementAppearance = scenario.observeNextNativeAppearance();
  await scenario.recreate();
  await replacementAppearance;
  const replacementClient = await scenario.open();
  const replacementDocument = scenario.resident();
  if (!replacementDocument) throw new Error('Expected the replacement resident');
  expect(replacementDocument).not.toBe(originalDocument);
  expect(replacementDocument.isDestroyed).toBe(false);
  expect(replacementClient.ytext.toString()).toBe(PENDING_PUBLICATION);
  const replacementDeletion = scenario.armDeletion('classified');
  scenario.deleteExternally();
  await replacementDeletion.waitUntilHeld();
  expect(scenario.resident()).toBe(replacementDocument);
  expect(replacementDocument.getMap('lifecycle').get('status')).toBeUndefined();
  await scenario.recreate();
  expect(scenario.resident()).toBe(replacementDocument);
  expect(replacementDocument.getMap('lifecycle').get('status')).toBeUndefined();
  expect(replacementDocument.getText('source').toString()).toBe(PENDING_PUBLICATION);

  await scenario.finishPendingWrite();
  expect(originalDocument.isDestroyed).toBe(true);
  expect(scenario.resident()).toBe(replacementDocument);
  await replacementDeletion.finish();
  expect(replacementDocument.isDestroyed, JSON.stringify(scenario.trace)).toBe(true);
  expect(scenario.resident()).not.toBe(replacementDocument);
  expect(scenario.disk()).toBe(PENDING_PUBLICATION);
});
