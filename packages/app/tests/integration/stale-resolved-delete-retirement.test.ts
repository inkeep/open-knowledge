import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { ConflictAuthority } from '../../../server/src/conflict-authority.ts';
import { DerivedDocumentIndex } from '../../../server/src/derived-document-index.ts';
import { runTeardownPhases } from '../stress/_helpers/teardown-fs.ts';
import { startDeletionScenario } from './stale-delete-recreation.test-helper.ts';

const deleteIndex = DerivedDocumentIndex.prototype.recordDiskDelete;
const cleanups: Array<() => Promise<void> | void> = [];
const registerCleanup = (cleanup: () => Promise<void> | void) => {
  cleanups.push(cleanup);
};

afterEach(async () => {
  await runTeardownPhases(...cleanups.splice(0).reverse());
});

test('a resolved deletion retires its unadopted old resident while preserving a recreated path', async () => {
  const scenario = await startDeletionScenario('none', registerCleanup);
  await scenario.open();
  const resident = scenario.server.instance.hocuspocus.documents.get(scenario.docName);
  if (!resident) throw new Error('Expected the original resident');
  const file = `${scenario.docName}.md`;
  const path = join(scenario.server.contentDir, file);
  const post = (route: string, body: unknown) =>
    fetch(`${scenario.server.baseUrl}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const raised = Promise.withResolvers<void>();
  const raiseConflict = ConflictAuthority.prototype.raise;
  const conflictSpy = vi.spyOn(ConflictAuthority.prototype, 'raise').mockImplementation(function (
    this: ConflictAuthority,
    input,
  ) {
    raiseConflict.call(this, input);
    if (input.kind === 'reconcile' && input.file === file) raised.resolve();
  });
  registerCleanup(() => conflictSpy.mockRestore());
  writeFileSync(path, '# Doc\n\n<<<<<<< ours\nalpha-ours\n=======\nalpha-theirs\n>>>>>>> theirs\n');
  await raised.promise;

  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const indexSpy = vi
    .spyOn(DerivedDocumentIndex.prototype, 'recordDiskDelete')
    .mockImplementation(async function (this: DerivedDocumentIndex, name) {
      await deleteIndex.call(this, name);
      if (name === scenario.docName) {
        reached.resolve();
        await release.promise;
      }
    });
  registerCleanup(() => indexSpy.mockRestore());
  const resolving = post('/api/sync/resolve-conflict', { file, strategy: 'delete' });
  registerCleanup(async () => {
    release.resolve();
    await resolving;
  });
  await reached.promise;
  expect(existsSync(path)).toBe(false);
  const created = await post('/api/create-page', { path: file });
  expect(created.status).toBe(200);
  expect(await created.json()).toEqual({ docName: scenario.docName });
  expect(readFileSync(path, 'utf8')).toBe('');
  expect(scenario.server.instance.hocuspocus.documents.get(scenario.docName)).toBe(resident);
  expect(resident.getMap('lifecycle').get('status')).toBeUndefined();
  expect(resident.getText('source').toString()).not.toBe('');

  release.resolve();
  expect((await resolving).status).toBe(200);
  expect(resident.isDestroyed).toBe(true);
  expect(scenario.server.instance.hocuspocus.documents.get(scenario.docName)).not.toBe(resident);
  expect(readFileSync(path, 'utf8')).toBe('');
  const response = await fetch(
    `${scenario.server.baseUrl}/api/document?docName=${scenario.docName}`,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ content: '' });
});
