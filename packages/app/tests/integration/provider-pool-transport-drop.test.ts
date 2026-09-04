import './idb-preload';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, test } from 'vitest';
import { ProviderPool } from '../../src/editor/provider-pool';
import {
  createRestartableServer,
  pollUntil,
  type RestartableServer,
  seedPoolServerInstanceId,
} from './test-harness';

const FIXTURE = `# Drop Doc

Body before the drop.
`;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
}, 30_000);

async function openSynced(server: RestartableServer, pool: ProviderPool, docName: string) {
  writeFileSync(join(server.contentDir, `${docName}.md`), FIXTURE, 'utf-8');
  pool.open(docName);
  pool.setActive(docName);
  await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);
  await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 10_000, 50);
  await wait(150);
}

function dropTransport(server: RestartableServer, docName: string): number {
  const document = server.instance.hocuspocus.documents.get(docName);
  if (!document) return 0;
  let dropped = 0;
  document.connections.forEach(
    (_clients: unknown, connection: { webSocket: { terminate(): void } }) => {
      connection.webSocket.terminate();
      dropped += 1;
    },
  );
  return dropped;
}

describe('ProviderPool transport drop recovery', () => {
  test('a synced doc re-syncs after an abrupt transport drop, and later server changes land', async () => {
    const server = await createRestartableServer();
    cleanups.push(() => server.shutdown());
    const docName = `test-${crypto.randomUUID()}`;

    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());
    await seedPoolServerInstanceId(server, pool);
    await openSynced(server, pool, docName);

    expect(dropTransport(server, docName)).toBeGreaterThan(0);

    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 15_000, 100);

    writeFileSync(
      join(server.contentDir, `${docName}.md`),
      `${FIXTURE}\nPOST-DROP MARKER\n`,
      'utf-8',
    );
    await pollUntil(
      () =>
        (pool.getActive()?.provider.document.getText('source').toString() ?? '').includes(
          'POST-DROP MARKER',
        ),
      15_000,
      100,
    );
  }, 60_000);

  test('a drop landing mid-churn (many concurrent disk writes) still recovers', async () => {
    const server = await createRestartableServer();
    cleanups.push(() => server.shutdown());
    const docName = `test-${crypto.randomUUID()}`;

    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());
    await seedPoolServerInstanceId(server, pool);
    await openSynced(server, pool, docName);

    for (let i = 0; i < 30; i += 1) {
      writeFileSync(join(server.contentDir, `churn-${i}.md`), `# churn ${i}\n`, 'utf-8');
    }
    dropTransport(server, docName);
    for (let i = 30; i < 60; i += 1) {
      writeFileSync(join(server.contentDir, `churn-${i}.md`), `# churn ${i}\n`, 'utf-8');
    }

    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 20_000, 100);
    writeFileSync(
      join(server.contentDir, `${docName}.md`),
      `${FIXTURE}\nCHURN-DROP MARKER\n`,
      'utf-8',
    );
    await pollUntil(
      () =>
        (pool.getActive()?.provider.document.getText('source').toString() ?? '').includes(
          'CHURN-DROP MARKER',
        ),
      20_000,
      100,
    );
  }, 60_000);

  test('two consecutive drops in quick succession still recover', async () => {
    const server = await createRestartableServer();
    cleanups.push(() => server.shutdown());
    const docName = `test-${crypto.randomUUID()}`;

    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());
    await seedPoolServerInstanceId(server, pool);
    await openSynced(server, pool, docName);

    dropTransport(server, docName);
    await pollUntil(() => dropTransport(server, docName) > 0, 10_000, 100);

    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 20_000, 100);
    writeFileSync(
      join(server.contentDir, `${docName}.md`),
      `${FIXTURE}\nSECOND-DROP MARKER\n`,
      'utf-8',
    );
    await pollUntil(
      () =>
        (pool.getActive()?.provider.document.getText('source').toString() ?? '').includes(
          'SECOND-DROP MARKER',
        ),
      15_000,
      100,
    );
  }, 60_000);
});
