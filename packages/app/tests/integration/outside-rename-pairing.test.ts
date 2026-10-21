import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { resolveShadowDir } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { contentHash } from '../../../server/src/file-watcher';
import { getLogger } from '../../../server/src/logger';
import { getMetrics } from '../../../server/src/metrics';
import { loadRenameLogIndex, resetRenameLogIndexCache } from '../../../server/src/rename-log';
import { VANISH_HOLD_LIMIT_MS } from '../../../server/src/vanished-documents';
import { createManualClock, type ManualClock } from '../../../server/src/watcher-clock.test-helper';
import { createWatcherDouble } from '../../../server/src/watcher-double.test-helper';
import { fetchDocNotices } from '../../src/hooks/use-doc-notices';
import {
  agentWriteMd,
  createTestClient,
  createTestServer,
  pollUntil,
  type TestClient,
  type TestServer,
} from './test-harness';

const SAVED = '# Doc\n\nShared paragraph.\n\nTail.\n';

const cleanups: Array<() => Promise<void> | void> = [];
const realFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = realFetch;
  resetRenameLogIndexCache();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Rig {
  server: TestServer;
  double: ReturnType<typeof createWatcherDouble>;
  clock: ManualClock;
  client: TestClient;
  docName: string;
  file: string;
  movedName: string;
  moved: string;
}

const CAN_REVOKE_READ = process.platform !== 'win32' && process.getuid?.() !== 0;

async function openUnsavedDocument(
  options: { debounce?: number; maxDebounce?: number } = {},
): Promise<Rig> {
  const double = createWatcherDouble();
  const clock = createManualClock(Date.now());
  const server = await createTestServer({
    gitEnabled: true,
    commitDebounceMs: 50,
    watcherBackend: double.backend,
    watcherClock: clock,
    freshnessIntervalMs: 5_000,
    debounce: options.debounce ?? 300_000,
    maxDebounce: options.maxDebounce ?? 600_000,
  });
  cleanups.push(() => server.cleanup());
  globalThis.fetch = (input, init) =>
    realFetch(
      typeof input === 'string' && input.startsWith('/')
        ? `http://127.0.0.1:${server.port}${input}`
        : input,
      init,
    );
  const docName = `outside-move-${randomUUID()}`;
  const file = join(server.contentDir, `${docName}.md`);
  await agentWriteMd(server.port, SAVED, { docName, position: 'replace' });
  await pollUntil(
    () => existsSync(file) && readFileSync(file, 'utf-8') === SAVED,
    10_000,
    25,
    'the seeded document to reach disk',
  );
  const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
  cleanups.push(() => client.cleanup());
  await pollUntil(() => client.ytext.toString() === SAVED, 10_000, 25, 'the client to load');
  const movedName = `${docName}-moved`;
  return {
    server,
    double,
    clock,
    client,
    docName,
    file,
    movedName,
    moved: join(server.contentDir, `${movedName}.md`),
  };
}

function liveText(rig: Rig, docName: string): string {
  return rig.server.instance.hocuspocus.documents.get(docName)?.getText('source').toString() ?? '';
}

function lifecycleOf(rig: Rig, docName: string): unknown {
  return rig.server.instance.hocuspocus.documents.get(docName)?.getMap('lifecycle').get('status');
}

async function type(rig: Rig, line: string): Promise<void> {
  rig.client.ytext.insert(rig.client.ytext.length, `\n${line}\n`);
  await pollUntil(() => liveText(rig, rig.docName).includes(line), 10_000, 25, `"${line}"`);
}

function deliver(rig: Rig, type: 'create' | 'update' | 'delete', path: string): void {
  rig.double.subscriptionFor(rig.server.contentDir).deliver([{ type, path }]);
}

async function textOf(rig: Rig, docName: string): Promise<string> {
  const response = await realFetch(
    `http://127.0.0.1:${rig.server.port}/api/document?docName=${encodeURIComponent(docName)}`,
  );
  if (response.status !== 200) return '';
  return ((await response.json()) as { content?: string }).content ?? '';
}

async function awaitRenamed(rig: Rig): Promise<void> {
  await pollUntil(() => lifecycleOf(rig, rig.docName) === 'renamed', 10_000, 25, 'the move');
}

async function awaitVanished(pendingBefore: number): Promise<void> {
  await pollUntil(
    () => getMetrics().vanishPending > pendingBefore,
    10_000,
    25,
    'the vanished document to be held',
  );
}

describe('an open document whose file moves outside the app', () => {
  test('a move delivered as a delete and later a create keeps the typing from before and during the gap', async () => {
    const rig = await openUnsavedDocument();
    await type(rig, 'Typed before the move.');
    const pendingBefore = getMetrics().vanishPending;

    renameSync(rig.file, rig.moved);
    deliver(rig, 'delete', rig.file);
    await awaitVanished(pendingBefore);
    expect(lifecycleOf(rig, rig.docName)).toBeUndefined();
    await type(rig, 'Typed while the move was half delivered.');

    deliver(rig, 'create', rig.moved);
    await awaitRenamed(rig);
    expect(
      rig.server.instance.hocuspocus.documents.get(rig.docName)?.getMap('lifecycle').get('newPath'),
    ).toBe(rig.movedName);
    await pollUntil(
      async () => (await textOf(rig, rig.movedName)).includes('Typed while the move'),
      10_000,
      25,
      'the moved document to carry the typing',
    );
    const moved = await textOf(rig, rig.movedName);
    expect(moved).toContain('Typed before the move.');
    expect(moved).toContain('Shared paragraph.');
    expect(existsSync(rig.file)).toBe(false);

    const durability = rig.server.instance.durabilityState;
    expect(durability.getReceipt(rig.docName)).toBeUndefined();
    expect(durability.getReceipt(rig.movedName)?.hash).toBe(
      contentHash(readFileSync(rig.moved, 'utf-8')),
    );

    await pollUntil(
      () => {
        resetRenameLogIndexCache();
        const renames = loadRenameLogIndex(resolveShadowDir(rig.server.contentDir));
        return renames.byTo.get(rig.movedName)?.from === rig.docName;
      },
      10_000,
      25,
      'the move to be recorded in the rename log',
    );
  }, 60_000);

  test('a move whose create the watcher never delivers is found by the re-check after the delete', async () => {
    const rig = await openUnsavedDocument();
    await type(rig, 'Typed before a silent move.');
    const pendingBefore = getMetrics().vanishPending;

    renameSync(rig.file, rig.moved);
    deliver(rig, 'delete', rig.file);
    await awaitVanished(pendingBefore);
    rig.clock.advance(1_000);

    await awaitRenamed(rig);
    await pollUntil(
      async () => (await textOf(rig, rig.movedName)).includes('Typed before a silent move.'),
      10_000,
      25,
      'the moved document to carry the typing',
    );
    expect(lifecycleOf(rig, rig.docName)).toBe('renamed');
    expect(existsSync(rig.file)).toBe(false);
  }, 60_000);

  test('a move with an edit is paired by file identity and the edit merges with the typing', async () => {
    const rig = await openUnsavedDocument();
    await type(rig, 'Typed before the move and edit.');
    const pairedBefore = getMetrics().vanishPairedIdentity;
    const pendingBefore = getMetrics().vanishPending;

    renameSync(rig.file, rig.moved);
    writeFileSync(rig.moved, '# Doc\n\nShared paragraph.\n\nTail, edited outside.\n');
    deliver(rig, 'delete', rig.file);
    await awaitVanished(pendingBefore);
    deliver(rig, 'create', rig.moved);

    await awaitRenamed(rig);
    expect(getMetrics().vanishPairedIdentity - pairedBefore).toBe(1);
    await pollUntil(
      async () => {
        const moved = await textOf(rig, rig.movedName);
        return (
          moved.includes('Typed before the move and edit.') && moved.includes('edited outside')
        );
      },
      10_000,
      25,
      'the typing and the outside edit to merge in the moved document',
    );
  }, 60_000);

  test('a delete with no matching create stands after the re-check, and the typing is kept in history', async () => {
    const rig = await openUnsavedDocument();
    await type(rig, 'Typed before the delete.');
    const deletedBefore = getMetrics().vanishDeleted;
    const pendingBefore = getMetrics().vanishPending;

    rmSync(rig.file);
    deliver(rig, 'delete', rig.file);
    await awaitVanished(pendingBefore);
    expect(lifecycleOf(rig, rig.docName)).toBeUndefined();
    rig.clock.advance(1_000);

    await pollUntil(
      () => getMetrics().vanishDeleted > deletedBefore,
      10_000,
      25,
      'the delete to stand',
    );
    expect(existsSync(rig.file)).toBe(false);
    await pollUntil(
      async () => {
        const response = await realFetch(`http://127.0.0.1:${rig.server.port}/api/rescue`);
        const entries = (await response.json()) as Array<{ docName: string }>;
        return entries.some((entry) => entry.docName === rig.docName);
      },
      10_000,
      50,
      'the typing to be kept in history',
    );
  }, 60_000);

  test('a save split into a delete and a create at the same path is taken in as an edit', async () => {
    const rig = await openUnsavedDocument();
    await type(rig, 'Typed before the outside save.');
    const recreatedBefore = getMetrics().vanishRecreated;
    const pendingBefore = getMetrics().vanishPending;

    rmSync(rig.file);
    deliver(rig, 'delete', rig.file);
    await awaitVanished(pendingBefore);
    writeFileSync(rig.file, '# Doc\n\nShared paragraph.\n\nTail, saved outside.\n');
    deliver(rig, 'create', rig.file);

    await pollUntil(
      () => liveText(rig, rig.docName).includes('saved outside'),
      10_000,
      25,
      'the outside save to merge',
    );
    expect(liveText(rig, rig.docName)).toContain('Typed before the outside save.');
    expect(lifecycleOf(rig, rig.docName)).toBeUndefined();
    expect(getMetrics().vanishRecreated - recreatedBefore).toBe(1);
  }, 60_000);

  test('the re-check that finds a file gone does not settle it; the next whole pass does', async () => {
    const rig = await openUnsavedDocument();
    await type(rig, 'Typed before a silent delete.');
    const pendingBefore = getMetrics().vanishPending;
    const deletedBefore = getMetrics().vanishDeleted;

    rmSync(rig.file);
    await rig.server.instance.recheckDisk();
    expect(getMetrics().vanishPending - pendingBefore).toBe(1);
    expect(getMetrics().vanishDeleted - deletedBefore).toBe(0);
    expect(lifecycleOf(rig, rig.docName)).toBeUndefined();
    expect(rig.server.instance.hocuspocus.documents.has(rig.docName)).toBe(true);

    await rig.server.instance.recheckDisk();
    expect(getMetrics().vanishDeleted - deletedBefore).toBe(1);
    expect(existsSync(rig.file)).toBe(false);
  }, 60_000);

  test.runIf(CAN_REVOKE_READ)(
    'a pass that cannot read the whole tree does not settle a held document, and the hold limit resolves it visibly',
    async () => {
      const rig = await openUnsavedDocument();
      const locked = join(rig.server.contentDir, 'locked');
      mkdirSync(locked);
      writeFileSync(join(locked, 'inside.md'), '# Inside\n');
      chmodSync(locked, 0o000);
      cleanups.push(() => chmodSync(locked, 0o755));
      await type(rig, 'Typed before a delete while a folder is unreadable.');
      const pendingBefore = getMetrics().vanishPending;
      const deletedBefore = getMetrics().vanishDeleted;
      const unconfirmedBefore = getMetrics().vanishUnconfirmed;

      rmSync(rig.file);
      deliver(rig, 'delete', rig.file);
      await awaitVanished(pendingBefore);
      await rig.server.instance.recheckDisk();
      await rig.server.instance.recheckDisk();
      expect(getMetrics().vanishDeleted - deletedBefore).toBe(0);
      expect(lifecycleOf(rig, rig.docName)).toBeUndefined();

      rig.clock.advance(VANISH_HOLD_LIMIT_MS);
      await pollUntil(
        () => getMetrics().vanishUnconfirmed > unconfirmedBefore,
        10_000,
        25,
        'the hold limit to resolve the document',
      );
      expect(getMetrics().vanishDeleted - deletedBefore).toBe(0);
      expect(existsSync(rig.file)).toBe(false);
      await pollUntil(
        async () => {
          const response = await realFetch(`http://127.0.0.1:${rig.server.port}/api/rescue`);
          const entries = (await response.json()) as Array<{ docName: string }>;
          return entries.some((entry) => entry.docName === rig.docName);
        },
        10_000,
        50,
        'the typing to be kept in history',
      );
    },
    60_000,
  );

  test('a held document whose settling fails after its hold ended is reported as released, and another still settles', async () => {
    const rig = await openUnsavedDocument();
    const otherName = `${rig.docName}-other`;
    const otherFile = join(rig.server.contentDir, `${otherName}.md`);
    await agentWriteMd(rig.server.port, SAVED, { docName: otherName, position: 'replace' });
    await pollUntil(
      () => existsSync(otherFile) && readFileSync(otherFile, 'utf-8') === SAVED,
      10_000,
      25,
      'the second document to reach disk',
    );
    const other = await createTestClient(rig.server.port, otherName, {
      skipInvariantWatcher: true,
    });
    cleanups.push(() => other.cleanup());
    await pollUntil(() => other.ytext.toString() === SAVED, 10_000, 25, 'the second client');
    const held = rig.server.instance.durabilityState;
    const releaseStores = held.releaseStores.bind(held);
    const releaseFault = vi.spyOn(held, 'releaseStores').mockImplementation((docName: string) => {
      if (docName === rig.docName) throw new Error('release fault');
      releaseStores(docName);
    });
    cleanups.push(() => releaseFault.mockRestore());
    const serverLog = getLogger('server');
    const faults: Array<{ docName?: unknown; stillHeld?: unknown; message: string }> = [];
    const logError = vi
      .spyOn(serverLog, 'error')
      .mockImplementation((data: unknown, message?: unknown) => {
        if (typeof message !== 'string' || !message.includes('internal error')) return;
        const fields = (data ?? {}) as { docName?: unknown; stillHeld?: unknown };
        faults.push({ docName: fields.docName, stillHeld: fields.stillHeld, message });
      });
    cleanups.push(() => logError.mockRestore());
    const pendingBefore = getMetrics().vanishPending;
    const deletedBefore = getMetrics().vanishDeleted;

    rmSync(rig.file);
    deliver(rig, 'delete', rig.file);
    await awaitVanished(pendingBefore);
    rmSync(otherFile);
    deliver(rig, 'delete', otherFile);
    await awaitVanished(pendingBefore + 1);
    await rig.server.instance.recheckDisk();

    expect(held.areStoresHeld(otherName)).toBe(false);
    expect(getMetrics().vanishDeleted - deletedBefore).toBe(1);
    expect(faults).toEqual([expect.objectContaining({ docName: rig.docName, stillHeld: false })]);
    expect(faults[0]?.message).toContain('its hold had already ended');
  }, 60_000);

  test('a store that fires while a document is held is deferred, and the typing reaches only the new name', async () => {
    const rig = await openUnsavedDocument({ debounce: 50, maxDebounce: 200 });
    const pendingBefore = getMetrics().vanishPending;
    const refusalsBefore = getMetrics().persistenceStoreRemovedDocCount;

    renameSync(rig.file, rig.moved);
    deliver(rig, 'delete', rig.file);
    await awaitVanished(pendingBefore);
    await type(rig, 'Typed while held, with a short save delay.');
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(getMetrics().persistenceStoreRemovedDocCount - refusalsBefore).toBe(0);
    expect(existsSync(rig.file)).toBe(false);

    deliver(rig, 'create', rig.moved);
    await awaitRenamed(rig);
    await pollUntil(
      () => readFileSync(rig.moved, 'utf-8').includes('Typed while held'),
      10_000,
      25,
      'the typing to be saved under the new name',
    );
    expect(existsSync(rig.file)).toBe(false);
    expect(getMetrics().persistenceStoreRemovedDocCount - refusalsBefore).toBe(0);
  }, 60_000);

  test('an agent edit made while the document is held is reported as moved with it when the move is found', async () => {
    const rig = await openUnsavedDocument();
    const pendingBefore = getMetrics().vanishPending;
    renameSync(rig.file, rig.moved);
    deliver(rig, 'delete', rig.file);
    await awaitVanished(pendingBefore);

    const write = realFetch(`http://127.0.0.1:${rig.server.port}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName: rig.docName,
        markdown: 'Agent line written while held.\n',
        position: 'append',
        agentId: 'held-writer',
      }),
    });
    await pollUntil(
      () => liveText(rig, rig.docName).includes('Agent line'),
      10_000,
      25,
      'the edit',
    );
    deliver(rig, 'create', rig.moved);

    const response = await write;
    expect(response.status).toBe(409);
    const body = (await response.json()) as { type?: string; detail?: string };
    expect(body.type).toBe('urn:ok:error:doc-moved');
    expect(body.detail).toContain(rig.movedName);
    await pollUntil(
      async () => (await textOf(rig, rig.movedName)).includes('Agent line written while held.'),
      10_000,
      25,
      'the agent edit to be in the moved document',
    );
  }, 60_000);

  test('an agent edit made while the document is held is asked to be re-applied when the move cannot carry it', async () => {
    const rig = await openUnsavedDocument();
    const pendingBefore = getMetrics().vanishPending;
    renameSync(rig.file, rig.moved);
    deliver(rig, 'delete', rig.file);
    await awaitVanished(pendingBefore);
    const hocuspocus = rig.server.instance.hocuspocus;
    const openDirect = hocuspocus.openDirectConnection.bind(hocuspocus);
    const carryFault = vi
      .spyOn(hocuspocus, 'openDirectConnection')
      .mockImplementation((...args: Parameters<typeof hocuspocus.openDirectConnection>) =>
        args[0] === rig.movedName ? Promise.reject(new Error('carry fault')) : openDirect(...args),
      );
    cleanups.push(() => carryFault.mockRestore());

    const write = realFetch(`http://127.0.0.1:${rig.server.port}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName: rig.docName,
        markdown: 'Agent line the move could not carry.\n',
        position: 'append',
        agentId: 'held-writer',
      }),
    });
    await pollUntil(
      () => liveText(rig, rig.docName).includes('Agent line'),
      10_000,
      25,
      'the edit',
    );
    deliver(rig, 'create', rig.moved);

    const response = await write;
    expect(response.status).toBe(409);
    const body = (await response.json()) as { type?: string; detail?: string };
    expect(body.type).toBe('urn:ok:error:doc-removed');
    expect(body.detail).toContain('re-apply your change there');
    expect(body.detail).toContain(rig.movedName);
    expect(carryFault).toHaveBeenCalledWith(rig.movedName);
  }, 60_000);

  test('an agent edit made while the document is held is reported as kept in history when the delete stands', async () => {
    const rig = await openUnsavedDocument();
    const pendingBefore = getMetrics().vanishPending;
    rmSync(rig.file);
    deliver(rig, 'delete', rig.file);
    await awaitVanished(pendingBefore);

    const write = realFetch(`http://127.0.0.1:${rig.server.port}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName: rig.docName,
        markdown: 'Agent line written before the delete stood.\n',
        position: 'append',
        agentId: 'held-writer',
      }),
    });
    await pollUntil(
      () => liveText(rig, rig.docName).includes('Agent line'),
      10_000,
      25,
      'the edit',
    );
    rig.clock.advance(1_000);

    const response = await write;
    expect(response.status).toBe(409);
    const body = (await response.json()) as { type?: string; title?: string; detail?: string };
    expect(body.type).toBe('urn:ok:error:doc-removed');
    expect(body.title).toContain('deleted outside the app');
    expect(body.detail).toContain('history');
    expect(existsSync(rig.file)).toBe(false);
  }, 60_000);

  test('a notice on the document follows it to its new name', async () => {
    const rig = await openUnsavedDocument();
    rig.client.doc.transact(() => {
      const at = rig.client.ytext.toString().indexOf('Shared paragraph.');
      rig.client.ytext.delete(at, 'Shared paragraph.'.length);
      rig.client.ytext.insert(at, 'Shared paragraph, edited here.');
    });
    await pollUntil(() => liveText(rig, rig.docName).includes('edited here'));
    writeFileSync(rig.file, '# Doc\n\nShared paragraph, edited outside.\n\nTail.\n');
    await rig.server.instance.recheckDisk();
    await pollUntil(
      async () =>
        ((await fetchDocNotices()) ?? []).some((notice) => notice.docName === rig.docName),
      10_000,
      50,
      'the both-kept notice',
    );
    const pendingBefore = getMetrics().vanishPending;

    renameSync(rig.file, rig.moved);
    deliver(rig, 'delete', rig.file);
    await awaitVanished(pendingBefore);
    deliver(rig, 'create', rig.moved);
    await awaitRenamed(rig);

    const notices = (await fetchDocNotices()) ?? [];
    expect(notices.filter((notice) => notice.docName === rig.docName)).toEqual([]);
    expect(notices.filter((notice) => notice.docName === rig.movedName)).toHaveLength(1);
  }, 60_000);
});
