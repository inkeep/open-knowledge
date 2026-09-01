import './idb-preload';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ProviderPool } from '../../src/editor/provider-pool';
import { refreshServerInfo } from '../../src/lib/server-info-refresh';
import {
  attachSystemDocSubscriber,
  createRestartableServer,
  pollUntil,
  seedPoolServerInstanceId,
} from './test-harness';

const FIXTURE = `# Rotation Fixture

Body paragraph that must survive the recycle.
`;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
}, 30_000);

function countRecycleBegins(calls: readonly unknown[][]): number {
  return calls.filter((call) => {
    const first = call[0];
    if (typeof first !== 'string') return false;
    try {
      return (JSON.parse(first) as { event?: string }).event === 'ok-pool-mismatch-recycle-begin';
    } catch {
      return false;
    }
  }).length;
}

describe('__system__ refresh across a server epoch rotation', () => {
  test('a refresh that observes the rotated epoch first still recycles the per-doc pool', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    cleanups.push(() => {
      infoSpy.mockRestore();
    });

    let server = await createRestartableServer();
    cleanups.push(() => server.shutdown());

    const docName = 'system-refresh-rotation-doc';
    writeFileSync(join(server.contentDir, `${docName}.md`), FIXTURE, 'utf-8');

    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`, { storage: null });
    cleanups.push(() => pool.dispose());
    const firstEpoch = await seedPoolServerInstanceId(server, pool);

    pool.open(docName);
    pool.setActive(docName);
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 10_000, 50);
    const staleProvider = pool.getActive()?.provider;
    if (!staleProvider) throw new Error('expected an active provider before the restart');

    const systemSub = attachSystemDocSubscriber(pool, server.port);
    cleanups.push(() => systemSub.dispose());
    await wait(200);

    server = await server.killAndRestartOnSamePort({ downtimeMs: 300 });
    cleanups.unshift(() => server.shutdown());

    const recyclesBeforeRefresh = countRecycleBegins(infoSpy.mock.calls);

    await refreshServerInfo(pool, `http://127.0.0.1:${server.port}`);
    const recyclesAfterRefresh = countRecycleBegins(infoSpy.mock.calls);

    expect(recyclesAfterRefresh).toBeGreaterThan(recyclesBeforeRefresh);

    const secondEpoch = await pool.whenServerInstanceKnown();
    expect(secondEpoch).not.toBe(firstEpoch);

    await pool.awaitMismatchSettled();
    await pollUntil(
      () => {
        const entry = pool.entries.get(docName);
        return entry !== undefined && entry.provider !== staleProvider;
      },
      10_000,
      50,
    );
    expect(pool.entries.get(docName)?.provider).not.toBe(staleProvider);

    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 15_000, 50);
    const body = pool.getActive()?.provider.document.getText('source').toString() ?? '';
    expect(body).toContain('Body paragraph that must survive the recycle.');
  }, 60_000);
});
