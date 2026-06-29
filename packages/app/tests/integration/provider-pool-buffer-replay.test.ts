
import './idb-preload';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { captureStateVector, computeUnsyncedUpdate } from '../../src/editor/client-persistence';
import { ProviderPool } from '../../src/editor/provider-pool';
import { createRestartableServer, pollUntil, seedPoolServerInstanceId } from './test-harness';

const SEED_MD = `# Seed Heading

Base paragraph.
`;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
}, 30_000);

describe('T12: buffer-and-replay across server-instance-mismatch', () => {
  test('clean mismatch recycle: no unsynced delta, no duplication, server state becomes authoritative', async () => {
    let server = await createRestartableServer();
    cleanups.push(() => server.shutdown());

    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());
    await seedPoolServerInstanceId(server, pool);

    writeFileSync(join(server.contentDir, 'test-doc.md'), SEED_MD, 'utf-8');
    pool.open('test-doc');
    pool.setActive('test-doc');
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 10_000, 50);
    await wait(500);

    server = await server.killAndRestartOnSamePort({ downtimeMs: 400 });
    cleanups.unshift(() => server.shutdown());
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 15_000, 50);

    const afterRestart = readFileSync(join(server.contentDir, 'test-doc.md'), 'utf-8');
    expect((afterRestart.match(/# Seed Heading/g) ?? []).length).toBe(1);
    expect((afterRestart.match(/Base paragraph\./g) ?? []).length).toBe(1);

    const entry = pool.getActive();
    if (!entry) throw new Error('pool has no active entry after recycle');
    expect(entry.lastServerSyncedSV).toBeInstanceOf(Uint8Array);
  }, 30_000);

  test('mismatch recycle calls persistence.clearData before destroy', async () => {
    let server = await createRestartableServer();
    cleanups.push(() => server.shutdown());

    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());
    await seedPoolServerInstanceId(server, pool);

    writeFileSync(join(server.contentDir, 'test-doc.md'), SEED_MD, 'utf-8');
    pool.open('test-doc');
    pool.setActive('test-doc');
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);

    const preRestartEntry = pool.getActive();
    if (!preRestartEntry?.persistence) throw new Error('expected pre-restart persistence');
    const preRestartPersistence = preRestartEntry.persistence;
    let clearDataCalled = false;
    const origClearData = preRestartPersistence.clearData.bind(preRestartPersistence);
    preRestartPersistence.clearData = async () => {
      clearDataCalled = true;
      return origClearData();
    };

    await wait(500);
    server = await server.killAndRestartOnSamePort({ downtimeMs: 400 });
    cleanups.unshift(() => server.shutdown());
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 15_000, 50);

    expect(clearDataCalled).toBe(true);

    const postRestartEntry = pool.getActive();
    if (!postRestartEntry) throw new Error('expected post-restart entry');
    expect(postRestartEntry.persistence).not.toBe(preRestartPersistence);
  }, 30_000);

  test('buffer-replay helpers are exported from client-persistence module', () => {
    expect(typeof captureStateVector).toBe('function');
    expect(typeof computeUnsyncedUpdate).toBe('function');
  });
});
