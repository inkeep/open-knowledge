import './idb-preload';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { ProviderPool } from '../../src/editor/provider-pool';
import {
  assertNoClientIdDrift,
  createRestartableServer,
  pollDiskContentStable,
  pollUntil,
  type RestartableServer,
  seedPoolServerInstanceId,
} from './test-harness';

const SMALL_FIXTURE = `[[asdf]]

# Test Documentasdfasdf

## Status

Status: complete

## Notes

Notes added by agent.

## Next Steps

Review patch behavior

# Test Document

## Status

Status: complete

## Notes

Notes added by agent.

## Next Steps

Review patch behavior

  Alpha
  Beta
  Gamma

  [[test-doc]]
  [[Nonexistent Page]]

[[blahboop]]

[[asdfasdfasdf]]
`;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
}, 30_000);

/** Seed the fixture on disk and wait for the pool's active provider to reach
 *  synced + zero unsynced changes. Returns the first provider instance so
 *  tests can assert reference identity after a restart. */
async function seedAndSyncSingleClient(
  server: RestartableServer,
  pool: ProviderPool,
  docName: string,
): Promise<import('@hocuspocus/provider').HocuspocusProvider> {
  writeFileSync(join(server.contentDir, `${docName}.md`), SMALL_FIXTURE, 'utf-8');
  pool.open(docName);
  pool.setActive(docName);
  await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);
  await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 10_000, 50);
  await wait(150);
  const first = pool.getActive()?.provider;
  if (!first) throw new Error('seedAndSyncSingleClient: provider missing after sync');
  return first;
}

describe('ProviderPool reconnects', () => {
  test('browser reload against same server keeps server Y.Doc loaded and avoids IDB duplication', async () => {
    const server = await createRestartableServer();
    cleanups.push(() => server.shutdown());

    const docName = 'reload-doc';
    writeFileSync(join(server.contentDir, `${docName}.md`), SMALL_FIXTURE, 'utf-8');

    const firstPool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    await seedPoolServerInstanceId(server, firstPool);
    await seedAndSyncSingleClient(server, firstPool, docName);
    await wait(300);

    const baseline = readFileSync(join(server.contentDir, `${docName}.md`), 'utf-8');
    const baselineHeadings = (baseline.match(/# Test Document/g) ?? []).length;
    const baselineLinks = (baseline.match(/\[\[test-doc\]\]/g) ?? []).length;
    expect(baselineHeadings).toBe(2);
    expect(baselineLinks).toBe(1);

    firstPool.dispose();
    await wait(100);

    expect(server.instance.hocuspocus.documents.has(docName)).toBe(true);

    const secondPool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => secondPool.dispose());
    await seedPoolServerInstanceId(server, secondPool);
    secondPool.open(docName);
    secondPool.setActive(docName);
    await pollUntil(() => secondPool.getActive()?.provider.isSynced === true, 10_000, 50);
    await wait(300);

    const afterReload = await pollDiskContentStable(
      join(server.contentDir, `${docName}.md`),
      (content) => content.includes('# Test Document') && content.includes('[[test-doc]]'),
      { timeoutMs: 5000, settleMs: 400 },
    );

    expect((afterReload.match(/# Test Document/g) ?? []).length).toBe(baselineHeadings);
    expect((afterReload.match(/\[\[test-doc\]\]/g) ?? []).length).toBe(baselineLinks);
  }, 20_000);

  test('page reload after server restart: epoch-scoped DB name prevents IDB hydration', async () => {
    let server = await createRestartableServer();
    cleanups.push(() => server.shutdown());

    const docName = 'page-reload-doc';
    writeFileSync(join(server.contentDir, `${docName}.md`), SMALL_FIXTURE, 'utf-8');

    const storageMap = new Map<string, string>();
    const storage = {
      getItem: (k: string) => storageMap.get(k) ?? null,
      setItem: (k: string, v: string) => {
        storageMap.set(k, v);
      },
      removeItem: (k: string) => {
        storageMap.delete(k);
      },
    };

    const firstPool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`, { storage });
    const firstServerId = await seedPoolServerInstanceId(server, firstPool);
    await seedAndSyncSingleClient(server, firstPool, docName);
    await wait(300);

    const baseline = readFileSync(join(server.contentDir, `${docName}.md`), 'utf-8');
    const baselineHeadings = (baseline.match(/# Test Document/g) ?? []).length;
    const baselineLinks = (baseline.match(/\[\[test-doc\]\]/g) ?? []).length;
    expect(baselineHeadings).toBe(2);
    expect(baselineLinks).toBe(1);

    firstPool.dispose();
    await wait(50);

    server = await server.killAndRestartOnSamePort({ downtimeMs: 500 });
    cleanups.unshift(() => server.shutdown());

    const secondPool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`, { storage });
    cleanups.push(() => secondPool.dispose());
    const secondServerId = await seedPoolServerInstanceId(server, secondPool);
    expect(secondServerId).not.toBe(firstServerId);
    secondPool.open(docName);
    secondPool.setActive(docName);
    await pollUntil(() => secondPool.getActive()?.provider.isSynced === true, 10_000, 50);
    await wait(300);

    const afterReload = await pollDiskContentStable(
      join(server.contentDir, `${docName}.md`),
      (c) => c.includes('# Test Document') && c.includes('[[test-doc]]'),
      { timeoutMs: 5000, settleMs: 400 },
    );

    expect((afterReload.match(/# Test Document/g) ?? []).length).toBe(baselineHeadings);
    expect((afterReload.match(/\[\[test-doc\]\]/g) ?? []).length).toBe(baselineLinks);
  }, 30_000);

  test('slow server restart (>4s): pool recycles, no duplication', async () => {
    let server = await createRestartableServer();
    cleanups.push(() => server.shutdown());

    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());
    await seedPoolServerInstanceId(server, pool);

    const firstProvider = await seedAndSyncSingleClient(server, pool, 'test-doc');

    const baseline = readFileSync(join(server.contentDir, 'test-doc.md'), 'utf-8');
    expect((baseline.match(/\[\[test-doc\]\]/g) ?? []).length).toBe(1);
    expect((baseline.match(/# Test Document/g) ?? []).length).toBe(2);

    server = await server.killAndRestartOnSamePort({ downtimeMs: 4500 });
    cleanups.unshift(() => server.shutdown());

    await pollUntil(() => pool.getActive()?.provider !== firstProvider, 10_000, 50);
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);

    expect(pool.getActive()?.provider).not.toBe(firstProvider);

    const afterRestart = await pollDiskContentStable(
      join(server.contentDir, 'test-doc.md'),
      (c) =>
        (c.match(/# Test Document/g) ?? []).length === 2 &&
        (c.match(/\[\[test-doc\]\]/g) ?? []).length === 1,
      { timeoutMs: 8000 },
    );
    expect((afterRestart.match(/\[\[test-doc\]\]/g) ?? []).length).toBe(1);
    expect((afterRestart.match(/# Test Document/g) ?? []).length).toBe(2);
    expect((afterRestart.match(/\[\[asdf\]\]/g) ?? []).length).toBe(1);
  }, 60_000);

  test('REPRO: fast server restart (<4s) keeps the same provider and duplicates content', async () => {
    let server = await createRestartableServer();
    cleanups.push(() => server.shutdown());

    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());
    await seedPoolServerInstanceId(server, pool);

    await seedAndSyncSingleClient(server, pool, 'test-doc');

    const baseline = readFileSync(join(server.contentDir, 'test-doc.md'), 'utf-8');
    const baselineTestDocLinks = (baseline.match(/\[\[test-doc\]\]/g) ?? []).length;
    const baselineHeadings = (baseline.match(/# Test Document/g) ?? []).length;
    const baselineAsdfLinks = (baseline.match(/\[\[asdf\]\]/g) ?? []).length;
    expect(baselineTestDocLinks).toBe(1);
    expect(baselineHeadings).toBe(2);
    expect(baselineAsdfLinks).toBe(1);

    const preRestartClientIds = new Set(pool.getActive()?.provider.document.store.clients.keys());

    server = await server.killAndRestartOnSamePort({ downtimeMs: 500 });
    cleanups.unshift(() => server.shutdown());

    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);

    const postRestartClientIds = new Set(pool.getActive()?.provider.document.store.clients.keys());
    const grewBy = postRestartClientIds.size - preRestartClientIds.size;
    console.log('[REPRO] clientID set', {
      preRestart: [...preRestartClientIds],
      postRestart: [...postRestartClientIds],
      grewBy,
    });

    const afterRestart = await pollDiskContentStable(
      join(server.contentDir, 'test-doc.md'),
      (c) => c.includes('# Test Document') && c.includes('[[test-doc]]'),
      { timeoutMs: 5000, settleMs: 400 },
    );
    const afterTestDocLinks = (afterRestart.match(/\[\[test-doc\]\]/g) ?? []).length;
    const afterHeadings = (afterRestart.match(/# Test Document/g) ?? []).length;
    const afterAsdfLinks = (afterRestart.match(/\[\[asdf\]\]/g) ?? []).length;

    console.log('[REPRO] counts', {
      baseline: {
        testDocLinks: baselineTestDocLinks,
        headings: baselineHeadings,
        asdf: baselineAsdfLinks,
      },
      after: {
        testDocLinks: afterTestDocLinks,
        headings: afterHeadings,
        asdf: afterAsdfLinks,
      },
      diskBytes: afterRestart.length,
    });

    expect(afterTestDocLinks).toBe(baselineTestDocLinks);
    expect(afterHeadings).toBe(baselineHeadings);
    expect(afterAsdfLinks).toBe(baselineAsdfLinks);

    const serverDoc = server.instance.hocuspocus.documents.get('test-doc');
    if (!serverDoc) throw new Error('server doc missing post-restart');
    const activeEntry = pool.getActive();
    if (!activeEntry) throw new Error('pool has no active entry after reconnect');
    assertNoClientIdDrift(
      {
        docName: 'test-doc',
        doc: activeEntry.provider.document,
        ytext: activeEntry.provider.document.getText('source'),
        fragment: activeEntry.provider.document.getXmlFragment('default'),
        provider: activeEntry.provider,
        pauseSync: () => {
          throw new Error('pauseSync not available');
        },
        resumeSync: () => {
          throw new Error('resumeSync not available');
        },
        cleanup: async () => {},
      },
      serverDoc,
      'post fast-restart',
    );
  }, 30_000);

  test('REPRO: unsynced local changes during restart preserve edit and avoid duplication', async () => {
    let server = await createRestartableServer();
    cleanups.push(() => server.shutdown());

    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());
    await seedPoolServerInstanceId(server, pool);

    const firstProvider = await seedAndSyncSingleClient(server, pool, 'test-doc');

    const UNIQUE_LOCAL_MARKER = 'T4-LOCAL-EDIT-MARKER-9f3a';
    const doc = firstProvider.document;
    const Y = await import('yjs');
    const paragraph = new Y.XmlElement('paragraph');
    const ytext = new Y.XmlText();
    ytext.applyDelta([{ insert: UNIQUE_LOCAL_MARKER }]);
    paragraph.insert(0, [ytext]);
    doc.getXmlFragment('default').push([paragraph]);

    await pollUntil(() => firstProvider.unsyncedChanges === 0, 180, 10);
    server.killNetwork();
    await wait(100);

    expect(pool.getActive()?.syncState).toBe('disconnected');

    server = await server.killAndRestartOnSamePort({ downtimeMs: 400 });
    cleanups.unshift(() => server.shutdown());

    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);

    await pollUntil(
      () =>
        pool
          .getActive()
          ?.provider.document.getText('source')
          .toString()
          .includes(UNIQUE_LOCAL_MARKER) ?? false,
      5000,
      50,
    );

    const afterRestart = await pollDiskContentStable(
      join(server.contentDir, 'test-doc.md'),
      (c) => c.includes(UNIQUE_LOCAL_MARKER),
      { timeoutMs: 8000, settleMs: 400 },
    );
    const afterHeadings = (afterRestart.match(/# Test Document/g) ?? []).length;
    const afterTestDocLinks = (afterRestart.match(/\[\[test-doc\]\]/g) ?? []).length;
    const afterLocalMarker = (afterRestart.match(new RegExp(UNIQUE_LOCAL_MARKER, 'g')) ?? [])
      .length;

    console.log('[T4] counts', {
      afterHeadings,
      afterTestDocLinks,
      afterLocalMarker,
      diskBytes: afterRestart.length,
    });

    expect(afterHeadings).toBe(2);
    expect(afterTestDocLinks).toBe(1);
    expect(afterLocalMarker).toBe(1);
  }, 30_000);
});
