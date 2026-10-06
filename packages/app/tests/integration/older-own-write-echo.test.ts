import { randomUUID } from 'node:crypto';
import { readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as agentSessions from '../../../server/src/agent-sessions';
import * as watcherModule from '../../../server/src/file-watcher';
import { contentHash } from '../../../server/src/version-hash';
import { createTestServer, type TestServer } from './test-harness';

const readOrder = vi.hoisted(() => ({
  path: '',
  hold: false,
  beforeRead: false,
  entered: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    readFile: async (...args: Parameters<typeof original.readFile>) => {
      const held = readOrder.hold && String(args[0]) === readOrder.path;
      if (held) readOrder.hold = false;
      if (held && readOrder.beforeRead) {
        readOrder.entered.resolve();
        await readOrder.release.promise;
      }
      const bytes = await original.readFile(...args);
      if (held && !readOrder.beforeRead) {
        readOrder.entered.resolve();
        await readOrder.release.promise;
      }
      return bytes;
    },
  };
});

let server: TestServer | undefined;
let pending: Promise<unknown>[] = [];
let gates: PromiseWithResolvers<void>[] = [];

function gate() {
  const opened = Promise.withResolvers<void>();
  gates.push(opened);
  return opened;
}

function watcherDecisionsFor(file: string) {
  return watcherModule
    .getWatcherDecisionRingSnapshot()
    .filter((record) => basename(record.path) === basename(file))
    .map((record) => record.decision);
}

afterEach(async () => {
  readOrder.hold = false;
  readOrder.beforeRead = false;
  readOrder.release.resolve();
  for (const opened of gates) opened.resolve();
  gates = [];
  await Promise.allSettled(pending);
  pending = [];
  vi.restoreAllMocks();
  await server?.cleanup();
  server = undefined;
});

async function startOrderedServer() {
  let dispatch: ((event: watcherModule.DiskEvent) => Promise<void>) | undefined;
  const startWatcher = watcherModule.startWatcher;
  vi.spyOn(watcherModule, 'startWatcher').mockImplementation(async (...args) => {
    dispatch = args[1];
    const handle = await startWatcher(...args);
    await handle.unsubscribe();
    return handle;
  });
  server = await createTestServer();
  const currentServer = server;
  if (!dispatch) throw new Error('Server watcher callback was not registered');
  const onDiskEvent = dispatch;
  const docName = `own-observation-${randomUUID()}`;
  const file = join(server.contentDir, `${docName}.md`);
  const fileIndex = new Map<string, watcherModule.FileIndexEntry>();
  const folderIndex = new Map<string, watcherModule.FolderIndexEntry>();
  return {
    server: currentServer,
    docName,
    file,
    fileIndex,
    folderIndex,
    onDiskEvent,
    post: (markdown: string) =>
      fetch(`${currentServer.baseUrl}/api/agent-write-md`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docName, agentId: 'ordered-writer', markdown, position: 'append' }),
      }),
    observe: () =>
      watcherModule.handleRawEvents(
        [{ type: 'update', path: file }],
        currentServer.contentDir,
        undefined,
        fileIndex,
        folderIndex,
        onDiskEvent,
      ),
  };
}

describe('older own-write observations', () => {
  test.each([
    {
      label: 'distinct text',
      first: 'Before\n',
      next: 'After\n',
      final: 'Final\n',
      acknowledged: 'Before\n\nAfter\n',
      expected: 'Before\n\nAfter\n\nFinal\n',
    },
    {
      label: 'repeated text',
      first: 'concurrent agent line\n',
      next: 'concurrent agent line\n',
      final: 'concurrent agent line\n',
      acknowledged: 'concurrent agent line\n\nconcurrent agent line\n',
      expected: 'concurrent agent line\n\nconcurrent agent line\n\nconcurrent agent line\n',
    },
    {
      label: 'unchanged content',
      first: 'Before\n',
      next: '',
      final: 'Final\n',
      acknowledged: 'Before\n',
      expected: 'Before\n\nFinal\n',
    },
  ])('an accepted write ignores an older observation with $label', async (contents) => {
    const { server: active, docName, file, post, observe } = await startOrderedServer();
    expect((await post(contents.first)).status).toBe(200);
    expect(readFileSync(file, 'utf8')).toBe(contents.first);
    readOrder.path = file;
    readOrder.entered = Promise.withResolvers<void>();
    readOrder.release = Promise.withResolvers<void>();
    readOrder.hold = true;
    const earlierBatch = observe();
    pending.push(earlierBatch);
    await readOrder.entered.promise;
    if (contents.next) expect((await post(contents.next)).status).toBe(200);
    await observe();
    expect(readFileSync(file, 'utf8')).toBe(contents.acknowledged);
    const raised = vi.spyOn(active.instance.conflicts, 'raise');
    const prepare = agentSessions.prepareAgentMarkdownParse;
    vi.spyOn(agentSessions, 'prepareAgentMarkdownParse').mockImplementation((...args) => {
      if (args[0].name === docName) readOrder.release.resolve();
      return prepare(...args);
    });
    const writing = post(contents.final);
    pending.push(writing);
    const response = await writing;
    await earlierBatch;
    expect.soft(response.status, JSON.stringify(await response.json())).toBe(200);
    expect.soft(raised.mock.calls.map(([input]) => input)).toEqual([]);
    expect.soft(active.instance.conflicts.findByDocName(docName)).toBeUndefined();
    expect.soft(readFileSync(file, 'utf8')).toBe(contents.expected);
    expect(active.instance.hocuspocus.documents.get(docName)?.getText('source').toString()).toBe(
      contents.expected,
    );
  });

  test('a stale external write of bytes the server never saved still refuses a write', async () => {
    const { server: active, docName, file, post, observe } = await startOrderedServer();
    const external = 'External seed\n';
    writeFileSync(file, external);
    const registrations = vi.spyOn(watcherModule, 'registerWrite');
    expect((await post('Acknowledged\n')).status).toBe(200);
    await observe();
    const acknowledged = 'External seed\n\nAcknowledged\n';
    expect(readFileSync(file, 'utf8')).toBe(acknowledged);
    expect(registrations.mock.calls.map(([, hash]) => hash)).toContain(contentHash(acknowledged));
    expect(registrations.mock.calls.map(([, hash]) => hash)).not.toContain(contentHash(external));
    writeFileSync(file, external);
    await observe();
    expect(active.instance.conflicts.findByDocName(docName)).toMatchObject({
      kind: 'reconcile',
      reason: 'stale-external-write',
      stages: { base: acknowledged, ours: acknowledged, theirs: external },
    });
    const response = await post('Final\n');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      type: 'urn:ok:error:doc-in-conflict',
      conflict: { kind: 'reconcile', reason: 'stale-external-write' },
    });
    expect(readFileSync(file, 'utf8')).toBe(external);
    expect(active.instance.hocuspocus.documents.get(docName)?.getText('source').toString()).toBe(
      acknowledged,
    );
  });

  test('an external rollback to an already observed own save still refuses a write', async () => {
    const { server: active, docName, file, post, observe } = await startOrderedServer();
    expect((await post('Before\n')).status).toBe(200);
    expect((await post('After\n')).status).toBe(200);
    await observe();
    writeFileSync(file, 'Before\n');
    await observe();
    expect(active.instance.conflicts.findByDocName(docName)).toMatchObject({
      kind: 'reconcile',
      reason: 'stale-external-write',
      stages: { base: 'Before\n\nAfter\n', ours: 'Before\n\nAfter\n', theirs: 'Before\n' },
    });
    const response = await post('Final\n');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      type: 'urn:ok:error:doc-in-conflict',
      conflict: { kind: 'reconcile', reason: 'stale-external-write' },
    });
    expect(readFileSync(file, 'utf8')).toBe('Before\n');
    expect(active.instance.hocuspocus.documents.get(docName)?.getText('source').toString()).toBe(
      'Before\n\nAfter\n',
    );
  });

  test('a newer external edit still reconciles before the next write', async () => {
    const { server: active, docName, file, post, observe } = await startOrderedServer();
    expect((await post('Before\n')).status).toBe(200);
    await observe();
    const raised = vi.spyOn(active.instance.conflicts, 'raise');
    writeFileSync(file, 'Edited outside\n');
    await observe();
    expect(active.instance.hocuspocus.documents.get(docName)?.getText('source').toString()).toBe(
      'Edited outside\n',
    );
    const response = await post('Final\n');
    expect(response.status).toBe(200);
    expect(raised.mock.calls.map(([input]) => input)).toEqual([]);
    expect(active.instance.conflicts.findByDocName(docName)).toBeUndefined();
    expect(readFileSync(file, 'utf8')).toBe('Edited outside\n\nFinal\n');
    expect(active.instance.hocuspocus.documents.get(docName)?.getText('source').toString()).toBe(
      'Edited outside\n\nFinal\n',
    );
  });

  test('an in-flight read still detects an external rollback after the own save was consumed', async () => {
    const { server: active, docName, file, post, observe } = await startOrderedServer();
    expect((await post('Before\n')).status).toBe(200);
    readOrder.path = file;
    readOrder.entered = Promise.withResolvers<void>();
    readOrder.release = Promise.withResolvers<void>();
    readOrder.beforeRead = true;
    readOrder.hold = true;
    const earlierBatch = observe();
    pending.push(earlierBatch);
    await readOrder.entered.promise;
    expect((await post('After\n')).status).toBe(200);
    await observe();
    writeFileSync(file, 'Before\n');
    readOrder.release.resolve();
    await earlierBatch;
    expect(active.instance.conflicts.findByDocName(docName)).toMatchObject({
      kind: 'reconcile',
      reason: 'stale-external-write',
      stages: { base: 'Before\n\nAfter\n', ours: 'Before\n\nAfter\n', theirs: 'Before\n' },
    });
    const response = await post('Final\n');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      type: 'urn:ok:error:doc-in-conflict',
      conflict: { kind: 'reconcile', reason: 'stale-external-write' },
    });
    expect(readFileSync(file, 'utf8')).toBe('Before\n');
    expect(active.instance.hocuspocus.documents.get(docName)?.getText('source').toString()).toBe(
      'Before\n\nAfter\n',
    );
  });

  test('an outside edit observed before an own save retains its conflict outcome', async () => {
    const { server: active, docName, file, post, observe } = await startOrderedServer();
    const registrations = vi.spyOn(watcherModule, 'registerWrite');
    expect((await post('Before\n')).status).toBe(200);
    await observe();
    const external = 'Outside edit\n';
    const acknowledged = 'OK save\n';
    writeFileSync(file, external);
    readOrder.path = file;
    readOrder.entered = Promise.withResolvers<void>();
    readOrder.release = Promise.withResolvers<void>();
    readOrder.hold = true;
    const earlierBatch = observe();
    pending.push(earlierBatch);
    await readOrder.entered.promise;
    const saved = await fetch(`${active.baseUrl}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName,
        agentId: 'ordered-writer',
        markdown: acknowledged,
        position: 'replace',
      }),
    });
    expect(saved.status, JSON.stringify(await saved.json())).toBe(200);
    await observe();
    expect(readFileSync(file, 'utf8')).toBe(acknowledged);
    expect(active.instance.conflicts.findByDocName(docName)).toBeUndefined();
    expect(registrations.mock.calls.map(([, hash]) => hash)).toContain(contentHash(acknowledged));
    expect(registrations.mock.calls.map(([, hash]) => hash)).not.toContain(contentHash(external));
    readOrder.release.resolve();
    await earlierBatch;
    expect(active.instance.conflicts.findByDocName(docName)).toMatchObject({
      kind: 'reconcile',
      reason: 'stale-external-write',
      stages: { base: acknowledged, ours: acknowledged, theirs: external },
    });
    const response = await post('Final\n');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      type: 'urn:ok:error:doc-in-conflict',
      conflict: { kind: 'reconcile', reason: 'stale-external-write' },
    });
    expect(readFileSync(file, 'utf8')).toBe(acknowledged);
    expect(active.instance.hocuspocus.documents.get(docName)?.getText('source').toString()).toBe(
      acknowledged,
    );
  });
  test('a superseded identical-byte outside rewrite is treated as an own echo', async () => {
    const { server: active, docName, file, post, observe } = await startOrderedServer();
    const registrations = vi.spyOn(watcherModule, 'registerWrite');
    const raised = vi.spyOn(active.instance.conflicts, 'raise');
    expect((await post('Before\n')).status).toBe(200);
    const external = 'Before\n';
    const acknowledged = 'OK save\n';
    writeFileSync(file, external);
    readOrder.path = file;
    readOrder.entered = Promise.withResolvers<void>();
    readOrder.release = Promise.withResolvers<void>();
    readOrder.hold = true;
    const earlierBatch = observe();
    pending.push(earlierBatch);
    await readOrder.entered.promise;
    const saved = await fetch(`${active.baseUrl}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName,
        agentId: 'ordered-writer',
        markdown: acknowledged,
        position: 'replace',
      }),
    });
    expect(saved.status, JSON.stringify(await saved.json())).toBe(200);
    await observe();
    expect(readFileSync(file, 'utf8')).toBe(acknowledged);
    expect(active.instance.conflicts.findByDocName(docName)).toBeUndefined();
    expect(registrations.mock.calls.map(([, hash]) => hash)).toContain(contentHash(acknowledged));
    expect(registrations.mock.calls.map(([, hash]) => hash)).toContain(contentHash(external));
    readOrder.release.resolve();
    await earlierBatch;
    expect(watcherDecisionsFor(file)).toEqual(['self-write-skip', 'superseded-own-write-skip']);
    expect(raised.mock.calls.map(([input]) => input)).toEqual([]);
    expect(active.instance.conflicts.findByDocName(docName)).toBeUndefined();
    expect(readFileSync(file, 'utf8')).toBe(acknowledged);
    expect(active.instance.hocuspocus.documents.get(docName)?.getText('source').toString()).toBe(
      acknowledged,
    );
  });

  test('a retargeted alias keeps the new target when an old-target save overlaps its read', async () => {
    const { server: active, docName, file, post } = await startOrderedServer();
    expect((await post('Before\n')).status).toBe(200);
    const targetName = `target-${randomUUID()}`;
    const target = join(active.contentDir, `${targetName}.md`);
    const aliasName = `alias-${randomUUID()}`;
    const alias = join(active.contentDir, `${aliasName}.md`);
    writeFileSync(target, 'Before\n');
    symlinkSync(file, alias);
    const aliases = new Map([[aliasName, docName]]);
    readOrder.path = alias;
    readOrder.entered = Promise.withResolvers<void>();
    readOrder.release = Promise.withResolvers<void>();
    readOrder.beforeRead = true;
    readOrder.hold = true;
    const observing = watcherModule.classifyEvents(
      [{ type: 'update', path: alias }],
      active.contentDir,
      undefined,
      aliases,
    );
    pending.push(observing);
    await readOrder.entered.promise;
    expect((await post('After\n')).status).toBe(200);
    unlinkSync(alias);
    symlinkSync(target, alias);
    expect(readFileSync(alias, 'utf8')).toBe('Before\n');
    expect(readFileSync(file, 'utf8')).toBe('Before\n\nAfter\n');
    readOrder.release.resolve();
    expect(await observing).toEqual([
      { kind: 'update', path: alias, docName: targetName, content: 'Before\n' },
    ]);
    expect(aliases.get(aliasName)).toBe(targetName);
    expect(watcherModule.lastKnownHash.get(alias)).toBe(contentHash('Before\n'));
  });

  test('an external rollback after a discarded older observation still refuses a write', async () => {
    const { server: active, docName, file, post, observe } = await startOrderedServer();
    expect((await post('Before\n')).status).toBe(200);
    readOrder.path = file;
    readOrder.entered = Promise.withResolvers<void>();
    readOrder.release = Promise.withResolvers<void>();
    readOrder.hold = true;
    const earlierBatch = observe();
    pending.push(earlierBatch);
    await readOrder.entered.promise;
    expect((await post('After\n')).status).toBe(200);
    expect(readFileSync(file, 'utf8')).toBe('Before\n\nAfter\n');
    readOrder.release.resolve();
    await earlierBatch;
    expect(active.instance.conflicts.findByDocName(docName)).toBeUndefined();
    writeFileSync(file, 'Before\n');
    await observe();
    expect(active.instance.conflicts.findByDocName(docName)).toMatchObject({
      kind: 'reconcile',
      reason: 'stale-external-write',
      stages: { base: 'Before\n\nAfter\n', ours: 'Before\n\nAfter\n', theirs: 'Before\n' },
    });
    const response = await post('Final\n');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      type: 'urn:ok:error:doc-in-conflict',
      conflict: { kind: 'reconcile', reason: 'stale-external-write' },
    });
    expect(readFileSync(file, 'utf8')).toBe('Before\n');
    expect(active.instance.hocuspocus.documents.get(docName)?.getText('source').toString()).toBe(
      'Before\n\nAfter\n',
    );
  });

  test('an own rename saved again during an earlier dispatch still moves its index entry', async () => {
    const { server: active } = await startOrderedServer();
    const firstOld = `rename-${randomUUID()}`;
    const firstNew = `rename-${randomUUID()}`;
    const secondOld = `rename-${randomUUID()}`;
    const secondNew = `rename-${randomUUID()}`;
    const path = (name: string) => join(active.contentDir, `${name}.md`);
    const moved = 'Moved outside\n';
    const ownMove = 'Moved by OK\n';
    const ownSave = 'Saved after the move\n';
    writeFileSync(path(firstNew), moved);
    writeFileSync(path(secondNew), ownMove);
    watcherModule.updateLastKnownHash(path(firstOld), contentHash(moved));
    watcherModule.updateLastKnownHash(path(secondOld), contentHash(ownMove));
    watcherModule.registerWrite(path(secondNew), contentHash(ownMove));
    const fileIndex = new Map<string, watcherModule.FileIndexEntry>(
      [firstOld, secondOld].map((name) => [
        name,
        {
          size: 0,
          modified: new Date(0).toISOString(),
          canonicalPath: path(name),
          inode: 0,
          aliases: [],
          kind: 'markdown',
        },
      ]),
    );
    const entered = gate();
    const release = gate();
    const dispatched: watcherModule.DiskEvent[] = [];
    const batch = watcherModule.handleRawEvents(
      [
        { type: 'delete', path: path(firstOld) },
        { type: 'create', path: path(firstNew) },
        { type: 'delete', path: path(secondOld) },
        { type: 'create', path: path(secondNew) },
      ],
      active.contentDir,
      undefined,
      fileIndex,
      new Map(),
      async (event) => {
        dispatched.push(event);
        if (event.kind === 'rename' && event.newDocName === firstNew) {
          entered.resolve();
          await release.promise;
        }
      },
    );
    pending.push(batch);
    await entered.promise;
    watcherModule.registerWrite(path(secondNew), contentHash(ownSave));
    writeFileSync(path(secondNew), ownSave);
    release.resolve();
    await batch;
    expect(dispatched).toEqual([
      {
        kind: 'rename',
        oldPath: path(firstOld),
        newPath: path(firstNew),
        oldDocName: firstOld,
        newDocName: firstNew,
        content: moved,
      },
    ]);
    const labels = new Map([
      [firstOld, 'first source'],
      [firstNew, 'first destination'],
      [secondOld, 'second source'],
      [secondNew, 'second destination'],
    ]);
    expect([...fileIndex.keys()].map((name) => labels.get(name) ?? name).sort()).toEqual([
      'first destination',
      'second destination',
    ]);
    expect(fileIndex.get(secondNew)).toMatchObject({ kind: 'markdown' });
  });

  test('an older observation held behind another dispatch does not refuse a later write', async () => {
    const {
      server: active,
      docName,
      file,
      fileIndex,
      folderIndex,
      onDiskEvent,
      post,
      observe,
    } = await startOrderedServer();
    const otherFile = join(active.contentDir, `outside-${randomUUID()}.md`);
    writeFileSync(otherFile, 'Outside\n');
    const raised = vi.spyOn(active.instance.conflicts, 'raise');
    expect((await post('Before\n')).status).toBe(200);
    const entered = gate();
    const release = gate();
    const earlierBatch = watcherModule.handleRawEvents(
      [
        { type: 'update', path: otherFile },
        { type: 'update', path: file },
      ],
      active.contentDir,
      undefined,
      fileIndex,
      folderIndex,
      async (event) => {
        if (event.kind === 'update' && event.path === otherFile) {
          entered.resolve();
          await release.promise;
        }
        await onDiskEvent(event);
      },
    );
    pending.push(earlierBatch);
    await entered.promise;
    expect((await post('After\n')).status).toBe(200);
    await observe();
    expect(readFileSync(file, 'utf8')).toBe('Before\n\nAfter\n');
    release.resolve();
    await earlierBatch;
    expect
      .soft(watcherDecisionsFor(file))
      .toEqual(['self-write-skip', 'superseded-own-write-skip']);
    const response = await post('Final\n');
    expect.soft(response.status, JSON.stringify(await response.json())).toBe(200);
    expect.soft(raised.mock.calls.map(([input]) => input)).toEqual([]);
    expect.soft(active.instance.conflicts.findByDocName(docName)).toBeUndefined();
    expect.soft(readFileSync(file, 'utf8')).toBe('Before\n\nAfter\n\nFinal\n');
    expect(active.instance.hocuspocus.documents.get(docName)?.getText('source').toString()).toBe(
      'Before\n\nAfter\n\nFinal\n',
    );
  });
});
