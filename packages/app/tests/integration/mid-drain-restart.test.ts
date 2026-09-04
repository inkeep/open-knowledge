import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, test } from 'vitest';
import { ProviderPool } from '../../src/editor/provider-pool';
import {
  agentWriteMd,
  attachSystemDocSubscriber,
  createRestartableServer,
  pollDiskContentStable,
  pollUntil,
  seedPoolServerInstanceId,
} from './test-harness';

const DURABILITY_MARKER = 'T11-DURABILITY-MARKER-7a3f';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe('T11: Mid-drain server restart', () => {
  test('content written shortly before crash survives restart; attribution may be forfeit', async () => {
    let server = await createRestartableServer({
      gitEnabled: true,
      commitDebounceMs: 2000,
      debounce: 100,
      maxDebounce: 300,
    });
    cleanups.push(() => server.shutdown());

    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());

    await seedPoolServerInstanceId(server, pool);
    const systemSub = attachSystemDocSubscriber(pool, server.port);
    cleanups.push(() => systemSub.dispose());

    pool.open('test-doc');
    pool.setActive('test-doc');
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);

    await agentWriteMd(server.port, `\n\n${DURABILITY_MARKER}\n`, {
      docName: 'test-doc',
      position: 'append',
      agentId: 't11-agent',
      agentName: 'T11-Agent',
    });

    await pollDiskContentStable(
      join(server.contentDir, 'test-doc.md'),
      (c) => c.includes(DURABILITY_MARKER),
      { timeoutMs: 5000, settleMs: 200 },
    );

    const contentDir = server.contentDir;
    const preRestartDisk = readFileSync(join(contentDir, 'test-doc.md'), 'utf-8');
    expect(preRestartDisk.includes(DURABILITY_MARKER)).toBe(true);

    await wait(500);
    server = await server.killAndRestartOnSamePort({ downtimeMs: 300 });
    cleanups.unshift(() => server.shutdown());

    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);

    await wait(500);

    const postRestartDisk = readFileSync(join(contentDir, 'test-doc.md'), 'utf-8');
    expect(postRestartDisk.includes(DURABILITY_MARKER)).toBe(true);

    const postEntry = pool.getActive();
    if (!postEntry) throw new Error('no active entry post-restart');
    const clientText = postEntry.provider.document.getText('source').toString();
    const markerCountClient = (clientText.match(new RegExp(DURABILITY_MARKER, 'g')) ?? []).length;
    const markerCountDisk = (postRestartDisk.match(new RegExp(DURABILITY_MARKER, 'g')) ?? [])
      .length;

    expect(markerCountClient).toBe(1);
    expect(markerCountDisk).toBe(1);
  }, 30_000);
});
