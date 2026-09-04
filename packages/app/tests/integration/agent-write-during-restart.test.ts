import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, test } from 'vitest';
import { ProviderPool } from '../../src/editor/provider-pool';
import {
  agentWriteMd,
  createRestartableServer,
  pollDiskContentStable,
  pollUntil,
  seedPoolServerInstanceId,
} from './test-harness';

const PRE_RESTART_MARKER = 'T6-PRE-RESTART-agent-write-alpha';
const POST_RESTART_MARKER = 'T6-POST-RESTART-agent-write-bravo';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe('T6: Agent write during restart', () => {
  test('REPRO: agent writes pre- and post-restart, tab open — no duplication', async () => {
    let server = await createRestartableServer();
    cleanups.push(() => server.shutdown());

    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());
    await seedPoolServerInstanceId(server, pool);

    pool.open('test-doc');
    pool.setActive('test-doc');
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);

    const firstProvider = pool.getActive()?.provider;
    if (!firstProvider) throw new Error('pre-restart provider missing');

    await agentWriteMd(server.port, `\n\n${PRE_RESTART_MARKER}\n`, {
      docName: 'test-doc',
      position: 'append',
      agentId: 't6-agent-1',
      agentName: 'T6-Agent-Pre',
    });

    await pollUntil(
      () =>
        pool
          .getActive()
          ?.provider.document.getText('source')
          .toString()
          .includes(PRE_RESTART_MARKER) ?? false,
      8000,
      50,
    );

    await pollDiskContentStable(
      join(server.contentDir, 'test-doc.md'),
      (c) => c.includes(PRE_RESTART_MARKER),
      { timeoutMs: 5000, settleMs: 300 },
    );

    server = await server.killAndRestartOnSamePort({ downtimeMs: 500 });
    cleanups.unshift(() => server.shutdown());

    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);

    await wait(500);

    await agentWriteMd(server.port, `\n\n${POST_RESTART_MARKER}\n`, {
      docName: 'test-doc',
      position: 'append',
      agentId: 't6-agent-2',
      agentName: 'T6-Agent-Post',
    });

    await pollUntil(
      () =>
        pool
          .getActive()
          ?.provider.document.getText('source')
          .toString()
          .includes(POST_RESTART_MARKER) ?? false,
      8000,
      50,
    );

    const finalDisk = await pollDiskContentStable(
      join(server.contentDir, 'test-doc.md'),
      (c) => c.includes(PRE_RESTART_MARKER) && c.includes(POST_RESTART_MARKER),
      { timeoutMs: 8000, settleMs: 400 },
    );

    const diskPreMarker = (finalDisk.match(new RegExp(PRE_RESTART_MARKER, 'g')) ?? []).length;
    const diskPostMarker = (finalDisk.match(new RegExp(POST_RESTART_MARKER, 'g')) ?? []).length;

    const activeEntry = pool.getActive();
    if (!activeEntry) throw new Error('pool has no active entry after reconnect');
    const clientText = activeEntry.provider.document.getText('source').toString();
    const clientPreMarker = (clientText.match(new RegExp(PRE_RESTART_MARKER, 'g')) ?? []).length;
    const clientPostMarker = (clientText.match(new RegExp(POST_RESTART_MARKER, 'g')) ?? []).length;

    console.log('[T6] marker counts', {
      disk: { pre: diskPreMarker, post: diskPostMarker, bytes: finalDisk.length },
      client: { pre: clientPreMarker, post: clientPostMarker, bytes: clientText.length },
    });

    expect(diskPreMarker).toBe(1);
    expect(diskPostMarker).toBe(1);
    expect(clientPreMarker).toBe(1);
    expect(clientPostMarker).toBe(1);
  }, 45_000);
});
