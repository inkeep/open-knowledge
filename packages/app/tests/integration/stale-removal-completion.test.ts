import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { ConflictAuthority } from '../../../server/src/conflict-authority.ts';
import { DerivedDocumentIndex } from '../../../server/src/derived-document-index.ts';
import { runTeardownPhases } from '../stress/_helpers/teardown-fs.ts';
import {
  ORIGINAL,
  RECREATED,
  startDeletionScenario,
} from './stale-delete-recreation.test-helper.ts';

const cleanups: Array<() => Promise<void> | void> = [];
const registerCleanup = (cleanup: () => Promise<void> | void) => {
  cleanups.push(cleanup);
};
const renameIndex = DerivedDocumentIndex.prototype.recordDiskRename;
const deleteIndex = DerivedDocumentIndex.prototype.recordDiskDelete;
const raiseConflict = ConflictAuthority.prototype.raise;

afterEach(async () => {
  await runTeardownPhases(...cleanups.splice(0).reverse());
});

test('a completed rename preserves a recreation admitted at its old name', async () => {
  const scenario = await startDeletionScenario('none', registerCleanup);
  const original = await scenario.open();
  expect(original.ytext.toString()).toBe(ORIGINAL);
  const destination = `moved-${scenario.docName}`;
  const sourcePath = join(scenario.server.contentDir, `${scenario.docName}.md`);
  const destinationPath = join(scenario.server.contentDir, `${destination}.md`);
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const indexSpy = vi
    .spyOn(DerivedDocumentIndex.prototype, 'recordDiskRename')
    .mockImplementation(async function (this: DerivedDocumentIndex, oldName, newName, content) {
      await renameIndex.call(this, oldName, newName, content);
      if (oldName === scenario.docName && newName === destination) {
        reached.resolve();
        await release.promise;
      }
    });
  registerCleanup(() => indexSpy.mockRestore());
  registerCleanup(() => release.resolve());

  renameSync(sourcePath, destinationPath);
  await reached.promise;
  expect(existsSync(sourcePath)).toBe(false);
  expect(readFileSync(destinationPath, 'utf-8')).toBe(ORIGINAL);

  const fresh = await scenario.create();
  const thread = await scenario.comment('Recreated page');
  expect(await scenario.snapshot(fresh)).toMatchObject({
    disk: RECREATED,
    residentPresent: true,
    residentContent: RECREATED,
    lifecycleStatus: null,
    clientContent: RECREATED,
    clientLifecycleStatus: null,
    clientClosed: false,
    removedCount: 0,
    listed: true,
    forwardLinks: ['target'],
  });

  release.resolve();
  await scenario.finishDeletion();
  const after = await scenario.snapshot(fresh);
  expect(readFileSync(destinationPath, 'utf-8')).toBe(ORIGINAL);
  expect(after.threads).toContain(thread.threadId);
  expect(after).toMatchObject({
    disk: RECREATED,
    residentPresent: true,
    residentContent: RECREATED,
    lifecycleStatus: null,
    clientContent: RECREATED,
    clientLifecycleStatus: null,
    clientClosed: false,
    removedCount: 0,
    listed: true,
    forwardLinks: ['target'],
  });
});

test('a completed conflict deletion preserves an accepted same-name creation', async () => {
  const scenario = await startDeletionScenario('none', registerCleanup);
  await scenario.open();
  const file = `${scenario.docName}.md`;
  const path = join(scenario.server.contentDir, file);
  const post = (route: string, body: unknown) =>
    fetch(`${scenario.server.baseUrl}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const raised = Promise.withResolvers<void>();
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
  const fresh = await scenario.open();
  const writing = await post('/api/agent-write-md', {
    docName: scenario.docName,
    markdown: RECREATED,
    position: 'replace',
    agentId: 'recreation-during-resolution',
  });
  expect(writing.status).toBe(409);
  expect(await writing.json()).toMatchObject({ type: 'urn:ok:error:doc-in-conflict' });
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
  expect((await resolving).status).toBe(200);
  const conflicts = await fetch(`${scenario.server.baseUrl}/api/sync/conflicts`);
  expect(conflicts.status).toBe(200);
  expect(await conflicts.json()).toEqual({ conflicts: [] });
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

test('a completed rename retires an unadopted resident loaded at its old name during the rename', async () => {
  const scenario = await startDeletionScenario('none', registerCleanup);
  const destination = `moved-${scenario.docName}`;
  const sourcePath = join(scenario.server.contentDir, `${scenario.docName}.md`);
  const destinationPath = join(scenario.server.contentDir, `${destination}.md`);
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const indexSpy = vi
    .spyOn(DerivedDocumentIndex.prototype, 'recordDiskRename')
    .mockImplementation(async function (this: DerivedDocumentIndex, oldName, newName, content) {
      await renameIndex.call(this, oldName, newName, content);
      if (oldName === scenario.docName && newName === destination) {
        reached.resolve();
        await release.promise;
      }
    });
  registerCleanup(() => indexSpy.mockRestore());
  registerCleanup(() => release.resolve());

  const hocuspocus = scenario.server.instance.hocuspocus;
  const load = hocuspocus.loadDocument.bind(hocuspocus);
  const loading = Promise.withResolvers<void>();
  const loaded = Promise.withResolvers<void>();
  const loadSpy = vi
    .spyOn(hocuspocus, 'loadDocument')
    .mockImplementation(async (...args: Parameters<typeof hocuspocus.loadDocument>) => {
      const document = await load(...args);
      if (args[0] === scenario.docName) {
        loading.resolve();
        await loaded.promise;
      }
      return document;
    });
  registerCleanup(() => loadSpy.mockRestore());
  registerCleanup(() => loaded.resolve());

  const opening = scenario.open();
  await loading.promise;
  expect(hocuspocus.documents.get(scenario.docName)).toBeUndefined();
  renameSync(sourcePath, destinationPath);
  await reached.promise;
  loaded.resolve();
  const late = await opening;
  expect(hocuspocus.documents.get(scenario.docName)).toBeDefined();

  release.resolve();
  await scenario.finishDeletion();
  expect(readFileSync(destinationPath, 'utf-8')).toBe(ORIGINAL);
  expect(await scenario.snapshot(late)).toMatchObject({
    lifecycleStatus: 'renamed',
    clientClosed: true,
  });
  expect(existsSync(sourcePath)).toBe(false);
});
