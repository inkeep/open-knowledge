import './idb-preload';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { ProviderPool } from '../../src/editor/provider-pool';
import { readReplayOutboxEntry } from '../../src/editor/replay-outbox';
import {
  createRestartableServer,
  pollDiskContentStable,
  pollUntil,
  seedPoolServerInstanceId,
} from './test-harness';

const SEED_MD = `# Durable Doc

Base paragraph.
`;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
}, 30_000);

async function outboxDbsForDoc(docName: string): Promise<string[]> {
  const dbs = await indexedDB.databases();
  return dbs
    .map((d) => d.name)
    .filter((n): n is string => typeof n === 'string')
    .filter((n) => n.startsWith('ok-replay-outbox:') && n.endsWith(`:${docName}`));
}

describe('durable replay outbox across server-instance-mismatch', () => {
  test('unsynced edit survives the same-tab recycle and its durable outbox is written then consumed', async () => {
    let server = await createRestartableServer();
    cleanups.push(() => server.shutdown());

    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());
    await seedPoolServerInstanceId(server, pool);

    const docName = 'durable-doc';
    writeFileSync(join(server.contentDir, `${docName}.md`), SEED_MD, 'utf-8');
    pool.open(docName);
    pool.setActive(docName);
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 10_000, 50);
    await wait(150);

    const marker = 'DURABLE-OUTBOX-MARKER-7b21';
    const firstProvider = pool.getActive()?.provider;
    if (!firstProvider) throw new Error('expected active provider');
    const paragraph = new Y.XmlElement('paragraph');
    const xmlText = new Y.XmlText();
    xmlText.applyDelta([{ insert: marker }]);
    paragraph.insert(0, [xmlText]);
    firstProvider.document.getXmlFragment('default').push([paragraph]);

    await pollUntil(() => firstProvider.unsyncedChanges === 0, 180, 10);
    server.killNetwork();
    await pollUntil(() => pool.getActive()?.syncState === 'disconnected', 5_000, 25);

    server = await server.killAndRestartOnSamePort({ downtimeMs: 400 });
    cleanups.unshift(() => server.shutdown());
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 15_000, 50);

    await pollUntil(
      () =>
        pool.getActive()?.provider.document.getText('source').toString().includes(marker) ?? false,
      5_000,
      50,
    );

    const afterRestart = await pollDiskContentStable(
      join(server.contentDir, `${docName}.md`),
      (c) => c.includes(marker),
      { timeoutMs: 8_000, settleMs: 400 },
    );
    expect((afterRestart.match(new RegExp(marker, 'g')) ?? []).length).toBe(1);
    expect((afterRestart.match(/# Durable Doc/g) ?? []).length).toBe(1);

    const outboxDbs = await outboxDbsForDoc(docName);
    expect(outboxDbs.length).toBeGreaterThanOrEqual(1);
    for (const dbName of outboxDbs) {
      const withoutDoc = dbName.slice(0, -(docName.length + 1));
      const branch = withoutDoc.slice('ok-replay-outbox:'.length);
      expect(branch).not.toContain(':');
      expect(await readReplayOutboxEntry({ branch, docName, namespace: null })).toBeNull();
    }

    const finalOnDisk = readFileSync(join(server.contentDir, `${docName}.md`), 'utf-8');
    expect((finalOnDisk.match(new RegExp(marker, 'g')) ?? []).length).toBe(1);
  }, 30_000);
});
