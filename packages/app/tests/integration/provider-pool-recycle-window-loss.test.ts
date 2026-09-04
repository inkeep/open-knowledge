import './idb-preload';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { ProviderPool } from '../../src/editor/provider-pool';
import { createRestartableServer, pollUntil, seedPoolServerInstanceId } from './test-harness';

const SEED = `# Seed

Adeline: 1652

## TODO

- item one
`;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
}, 30_000);

describe('disconnect-recycle window vs local edit', () => {
  test('an edit typed during the armed recycle-debounce window survives the recycle', async () => {
    let server = await createRestartableServer();
    cleanups.push(() => server.shutdown());

    const docName = `recycle-window-${crypto.randomUUID()}`;
    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`, {
      recycleDebounceMs: 250,
    });
    cleanups.push(() => pool.dispose());
    await seedPoolServerInstanceId(server, pool);

    writeFileSync(join(server.contentDir, `${docName}.md`), SEED, 'utf-8');
    pool.open(docName);
    pool.setActive(docName);
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 10_000, 50);

    const firstProvider = pool.getActive()?.provider;
    if (!firstProvider) throw new Error('no active provider after seed');

    server.killNetwork();
    await pollUntil(() => pool.getActive()?.syncState === 'disconnected', 5_000, 20);

    const MARKER = 'RW-LOCAL-EDIT-MARKER-c41d';
    const doc = firstProvider.document;
    const paragraph = new Y.XmlElement('paragraph');
    const xtext = new Y.XmlText();
    xtext.applyDelta([{ insert: MARKER }]);
    paragraph.insert(0, [xtext]);
    doc.getXmlFragment('default').push([paragraph]);
    expect(firstProvider.unsyncedChanges).toBeGreaterThan(0);

    await wait(700);
    const recycled = pool.getActive()?.provider !== firstProvider;

    server = await server.killAndRestartOnSamePort({ downtimeMs: 300 });
    cleanups.unshift(() => server.shutdown());
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 15_000, 50);
    await wait(1_000);

    const finalText =
      pool.getActive()?.provider.document.getXmlFragment('default').toString() ?? '';
    const finalSource = pool.getActive()?.provider.document.getText('source').toString() ?? '';

    console.info(
      JSON.stringify({
        event: 'recycle-window-loss-diagnostic',
        recycled,
        markerInFragment: finalText.includes(MARKER),
        markerInSource: finalSource.includes(MARKER),
      }),
    );

    expect(finalText.includes(MARKER) || finalSource.includes(MARKER)).toBe(true);
    expect(finalText.split(MARKER).length - 1).toBeLessThanOrEqual(1);
    expect(finalSource.split(MARKER).length - 1).toBeLessThanOrEqual(1);
  }, 40_000);

  test('a source-mode edit typed during the window survives a server-identity change', async () => {
    let server = await createRestartableServer();
    cleanups.push(() => server.shutdown());

    const docName = `recycle-window-src-${crypto.randomUUID()}`;
    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`, {
      recycleDebounceMs: 250,
    });
    cleanups.push(() => pool.dispose());
    await seedPoolServerInstanceId(server, pool);

    writeFileSync(join(server.contentDir, `${docName}.md`), SEED, 'utf-8');
    pool.open(docName);
    pool.setActive(docName);
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 10_000, 50);

    const firstProvider = pool.getActive()?.provider;
    if (!firstProvider) throw new Error('no active provider after seed');

    server.killNetwork();
    await pollUntil(() => pool.getActive()?.syncState === 'disconnected', 5_000, 20);

    const MARKER = 'RW-SOURCE-EDIT-MARKER-9a3b';
    const ytext = firstProvider.document.getText('source');
    firstProvider.document.transact(() => {
      ytext.insert(ytext.length, `\n${MARKER}\n`);
    });
    expect(firstProvider.unsyncedChanges).toBeGreaterThan(0);

    await wait(700);

    server = await server.killAndRestartOnSamePort({ downtimeMs: 300 });
    cleanups.unshift(() => server.shutdown());
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 15_000, 50);
    await wait(1_000);

    const finalSource = pool.getActive()?.provider.document.getText('source').toString() ?? '';
    expect(finalSource.includes(MARKER)).toBe(true);
    expect(finalSource.split(MARKER).length - 1).toBe(1);
  }, 40_000);

  test('a dirty entry is not recycled when the debounce window elapses offline', async () => {
    const server = await createRestartableServer();
    cleanups.push(() => server.shutdown());

    const docName = `recycle-window-dirty-${crypto.randomUUID()}`;
    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`, {
      recycleDebounceMs: 250,
    });
    cleanups.push(() => pool.dispose());
    await seedPoolServerInstanceId(server, pool);

    writeFileSync(join(server.contentDir, `${docName}.md`), SEED, 'utf-8');
    pool.open(docName);
    pool.setActive(docName);
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 10_000, 50);

    const firstProvider = pool.getActive()?.provider;
    if (!firstProvider) throw new Error('no active provider after seed');

    server.killNetwork();
    await pollUntil(() => pool.getActive()?.syncState === 'disconnected', 5_000, 20);

    const MARKER = 'RW-DIRTY-EDIT-MARKER-77e2';
    const doc = firstProvider.document;
    const paragraph = new Y.XmlElement('paragraph');
    const xtext = new Y.XmlText();
    xtext.applyDelta([{ insert: MARKER }]);
    paragraph.insert(0, [xtext]);
    doc.getXmlFragment('default').push([paragraph]);
    expect(firstProvider.unsyncedChanges).toBeGreaterThan(0);

    await wait(700);

    expect(pool.getActive()?.provider).toBe(firstProvider);
    expect(firstProvider.document.getXmlFragment('default').toString().includes(MARKER)).toBe(true);
  }, 40_000);

  test('a clean content-bearing entry is preserved across the debounce window', async () => {
    const server = await createRestartableServer();
    cleanups.push(() => server.shutdown());

    const docName = `recycle-window-clean-${crypto.randomUUID()}`;
    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`, {
      recycleDebounceMs: 250,
    });
    cleanups.push(() => pool.dispose());
    await seedPoolServerInstanceId(server, pool);

    writeFileSync(join(server.contentDir, `${docName}.md`), SEED, 'utf-8');
    pool.open(docName);
    pool.setActive(docName);
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 10_000, 50);

    const firstProvider = pool.getActive()?.provider;
    if (!firstProvider) throw new Error('no active provider after seed');

    server.killNetwork();
    await pollUntil(() => pool.getActive()?.syncState === 'disconnected', 5_000, 20);

    expect(pool.getActive()?.pendingRecycleTimer ?? null).toBeNull();

    await wait(600);
    expect(pool.getActive()?.provider).toBe(firstProvider);
    expect(firstProvider.document.getText('source').toString()).toContain('Adeline: 1652');

    const reopened = pool.open(docName);
    expect(reopened?.provider).toBe(firstProvider);
    expect(firstProvider.document.getText('source').toString()).toContain('Adeline: 1652');
  }, 40_000);
});
