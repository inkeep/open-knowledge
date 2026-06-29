import './idb-preload';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import * as clientPersistence from '../../src/editor/client-persistence';
import { ProviderPool } from '../../src/editor/provider-pool';
import {
  createRestartableServer,
  pollDiskContentStable,
  pollUntil,
  seedPoolServerInstanceId,
} from './test-harness';

const DOC_A_NAME = 'doc-a';
const DOC_B_NAME = 'doc-b';

const DOC_A_FIXTURE = `# Doc A

AA-CROSS-STALE-UUq3 Doc A baseline for epoch-scoped IDB naming.

## A section

Foot AA-SECTION-UUq3
`;

const DOC_B_FIXTURE = `# Doc B

BB-CROSS-STALE-VVt4 Doc B baseline; second doc exercises cross-doc masking.

## B section

Tail BB-TAIL-VVt4
`;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
}, 45_000);

async function syncOpenDoc(pool: ProviderPool, docName: string): Promise<void> {
  pool.open(docName);
  pool.setActive(docName);
  await pollUntil(
    () => pool.getActive()?.docName === docName && pool.getActive()?.provider.isSynced === true,
    10_000,
    50,
  );
  await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 10_000, 50);
  await wait(150);
}

describe('Cross-document stale cache (epoch-scoped IDB)', () => {
  test('after server restart, opening doc-a then doc-b does not duplicate doc-b disk body', async () => {
    let server = await createRestartableServer();
    cleanups.push(() => server.shutdown());

    writeFileSync(join(server.contentDir, `${DOC_A_NAME}.md`), DOC_A_FIXTURE, 'utf-8');
    writeFileSync(join(server.contentDir, `${DOC_B_NAME}.md`), DOC_B_FIXTURE, 'utf-8');

    const firstPool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => firstPool.dispose());
    const firstServerId = await seedPoolServerInstanceId(server, firstPool);

    await syncOpenDoc(firstPool, DOC_A_NAME);
    await syncOpenDoc(firstPool, DOC_B_NAME);
    await wait(300);

    const baselineB = readFileSync(join(server.contentDir, `${DOC_B_NAME}.md`), 'utf-8');
    expect((baselineB.match(/BB-CROSS-STALE-VVt4/g) ?? []).length).toBe(1);
    expect((baselineB.match(/BB-TAIL-VVt4/g) ?? []).length).toBe(1);
    expect((baselineB.match(/# Doc B/g) ?? []).length).toBe(1);

    firstPool.dispose();
    await wait(50);

    server = await server.killAndRestartOnSamePort({ downtimeMs: 400 });
    cleanups.unshift(() => server.shutdown());

    const persistenceCreateCalls: Parameters<
      typeof clientPersistence.createClientPersistence
    >[0][] = [];
    const originalCreate = clientPersistence.createClientPersistence.bind(clientPersistence);
    const createSpy = spyOn(clientPersistence, 'createClientPersistence').mockImplementation(
      (args) => {
        persistenceCreateCalls.push(args);
        return originalCreate(args);
      },
    );
    cleanups.push(() => createSpy.mockRestore());

    const secondPool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => secondPool.dispose());

    const secondServerId = await seedPoolServerInstanceId(server, secondPool);
    expect(secondServerId).not.toBe(firstServerId);
    expect(persistenceCreateCalls.length).toBe(0);

    await syncOpenDoc(secondPool, DOC_A_NAME);
    await syncOpenDoc(secondPool, DOC_B_NAME);
    await wait(250);

    const docBPath = join(server.contentDir, `${DOC_B_NAME}.md`);
    const settledB = await pollDiskContentStable(
      docBPath,
      (c) =>
        c.includes('BB-CROSS-STALE-VVt4') && c.includes('BB-TAIL-VVt4') && c.includes('# Doc B'),
      { timeoutMs: 8000, settleMs: 400 },
    );

    expect((settledB.match(/BB-CROSS-STALE-VVt4/g) ?? []).length).toBe(1);
    expect((settledB.match(/BB-TAIL-VVt4/g) ?? []).length).toBe(1);
    expect((settledB.match(/# Doc B/g) ?? []).length).toBe(1);

    const docBPersistenceCalls = persistenceCreateCalls.filter((a) => a.docName === DOC_B_NAME);
    expect(docBPersistenceCalls.length).toBeGreaterThan(0);
    for (const args of docBPersistenceCalls) {
      expect(args.serverInstanceId).toBe(secondServerId);
      expect(
        args.serverInstanceId.length > 0 && args.branch.length > 0 && args.docName === DOC_B_NAME,
      ).toBe(true);
    }
  }, 35_000);
});
