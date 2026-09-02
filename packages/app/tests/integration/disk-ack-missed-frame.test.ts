import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, test } from 'vitest';
import { ProviderPool } from '../../src/editor/provider-pool';
import { refreshServerInfo } from '../../src/lib/server-info-refresh';
import {
  agentWriteMd,
  attachSystemDocSubscriber,
  createRestartableServer,
  pollDiskContentStable,
  pollUntil,
} from './test-harness';

const MARKER = 'T15-MISSED-FRAME-MARKER-9b2e';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe('T15: Missed disk-ack frame recovery via /api/server-info', () => {
  test('systemSub disconnect during write burst, reconnect refreshes watermarks, no duplication after restart', async () => {
    let server = await createRestartableServer({
      gitEnabled: true,
      commitDebounceMs: 2000,
      debounce: 100,
      maxDebounce: 300,
    });
    cleanups.push(() => server.shutdown());

    const baseUrl = `http://127.0.0.1:${server.port}`;
    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());

    await refreshServerInfo(pool, baseUrl);

    let systemSub = attachSystemDocSubscriber(pool, server.port);
    cleanups.push(() => systemSub.dispose());

    pool.open('test-doc');
    pool.setActive('test-doc');
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);

    const firstProvider = pool.getActive()?.provider;
    if (!firstProvider) throw new Error('pre-disconnect provider missing');

    await agentWriteMd(server.port, '\n\nPHASE-1-PRE-DISCONNECT\n', {
      docName: 'test-doc',
      position: 'append',
      agentId: 't15-agent',
      agentName: 'T15-Agent',
    });
    await pollDiskContentStable(
      join(server.contentDir, 'test-doc.md'),
      (c) => c.includes('PHASE-1-PRE-DISCONNECT'),
      { timeoutMs: 5_000, settleMs: 200 },
    );
    await wait(300);

    await systemSub.dispose();

    await agentWriteMd(server.port, `${MARKER}\n`, {
      docName: 'test-doc',
      position: 'append',
      agentId: 't15-agent',
      agentName: 'T15-Agent',
    });
    await pollDiskContentStable(join(server.contentDir, 'test-doc.md'), (c) => c.includes(MARKER), {
      timeoutMs: 5_000,
      settleMs: 200,
    });
    const preRestartDisk = readFileSync(join(server.contentDir, 'test-doc.md'), 'utf-8');
    expect(preRestartDisk.includes(MARKER)).toBe(true);

    await refreshServerInfo(pool, baseUrl);
    systemSub = attachSystemDocSubscriber(pool, server.port);
    cleanups.push(() => systemSub.dispose());

    server = await server.killAndRestartOnSamePort({ downtimeMs: 300 });
    cleanups.unshift(() => server.shutdown());

    await pollUntil(() => pool.getActive()?.provider !== firstProvider, 10_000, 50);
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);
    await wait(500);

    const postRestartDisk = readFileSync(join(server.contentDir, 'test-doc.md'), 'utf-8');
    const postProvider = pool.getActive()?.provider;
    if (!postProvider) throw new Error('post-restart provider missing');
    const clientText = postProvider.document.getText('source').toString();

    const markerCountClient = (clientText.match(new RegExp(MARKER, 'g')) ?? []).length;
    const markerCountDisk = (postRestartDisk.match(new RegExp(MARKER, 'g')) ?? []).length;

    expect(markerCountClient).toBe(1);
    expect(markerCountDisk).toBe(1);
  }, 45_000);
});
