import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, test } from 'vitest';
import { ProviderPool } from '../../src/editor/provider-pool';
import {
  assertIDBEmpty,
  createRestartableServer,
  pollDiskContentStable,
  pollUntil,
  seedPoolServerInstanceId,
} from './test-harness';

const COLD_START_FIXTURE = `# Cold Start Doc

Paragraph A: unique marker T13-ALPHA.

Paragraph B: unique marker T13-BRAVO.

[[cold-sibling]]
`;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe('T13: cold start with empty IDB after server restart', () => {
  test('empty IDB + restarted server: syncs cleanly, no duplication', async () => {
    let server = await createRestartableServer();
    cleanups.push(() => server.shutdown());
    writeFileSync(join(server.contentDir, 'test-doc.md'), COLD_START_FIXTURE, 'utf-8');

    await wait(250);

    server = await server.killAndRestartOnSamePort({ downtimeMs: 400 });
    cleanups.unshift(() => server.shutdown());

    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());
    const serverInstanceId = await seedPoolServerInstanceId(server, pool);

    await assertIDBEmpty('test-doc', serverInstanceId);

    pool.open('test-doc');
    pool.setActive('test-doc');

    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 10_000, 50);

    await wait(200);

    const entry = pool.getActive();
    if (!entry) throw new Error('pool has no active entry after sync');
    const clientText = entry.provider.document.getText('source').toString();

    expect((clientText.match(/T13-ALPHA/g) ?? []).length).toBe(1);
    expect((clientText.match(/T13-BRAVO/g) ?? []).length).toBe(1);
    expect((clientText.match(/\[\[cold-sibling\]\]/g) ?? []).length).toBe(1);
    expect((clientText.match(/# Cold Start Doc/g) ?? []).length).toBe(1);

    const diskAfter = await pollDiskContentStable(
      join(server.contentDir, 'test-doc.md'),
      (c) => c.includes('T13-ALPHA') && c.includes('T13-BRAVO'),
      { timeoutMs: 5000, settleMs: 300 },
    );
    expect((diskAfter.match(/T13-ALPHA/g) ?? []).length).toBe(1);
    expect((diskAfter.match(/T13-BRAVO/g) ?? []).length).toBe(1);

    const onDisk = readFileSync(join(server.contentDir, 'test-doc.md'), 'utf-8');
    expect(onDisk).toContain('Paragraph A: unique marker T13-ALPHA.');
    expect(onDisk).toContain('Paragraph B: unique marker T13-BRAVO.');
  }, 30_000);
});
