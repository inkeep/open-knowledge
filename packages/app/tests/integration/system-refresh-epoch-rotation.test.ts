/**
 * The token-less `__system__` refresh must not suppress per-doc recycle.
 *
 * `__system__` is constructed without an auth token, so it carries no epoch
 * claim and the server's stale-claim rejection never applies to it. After a
 * server restart it therefore re-syncs freely and its reconnect refresh
 * reaches the pool over HTTP, while per-doc providers are still retrying
 * tokens frozen with the dead epoch. If that refresh is allowed to be a
 * plain field write, the pool caches the new epoch and every subsequent
 * per-doc rejection is discarded as "already handled" — the docs stay
 * offline for the rest of the session, showing a reconnect toast that
 * promises edits will sync.
 *
 * Both halves have to be wired at once for the composition to be observable:
 * the refresher alone recycles nothing, and a restart without a `__system__`
 * subscriber never produces the suppressing write. The ordering is forced
 * rather than raced, so this is a falsifier and not a coin flip.
 */

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

/** Recycle entries observed on the structured breadcrumb channel. */
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

    // The half that was never wired alongside a recycle assertion.
    const systemSub = attachSystemDocSubscriber(pool, server.port);
    cleanups.push(() => systemSub.dispose());
    await wait(200);

    // Short downtime keeps the pool's debounced disconnect-recycle out of the
    // picture, so any recycle observed below is attributable to the epoch
    // transition and nothing else.
    server = await server.killAndRestartOnSamePort({ downtimeMs: 300 });
    cleanups.unshift(() => server.shutdown());

    const recyclesBeforeRefresh = countRecycleBegins(infoSpy.mock.calls);

    // Force the arm rather than race it. Hocuspocus's first reconnect attempt
    // is a second out, so the per-doc provider cannot have been rejected yet:
    // whatever this observes is the refresh reaching the pool alone. This is
    // the same call the `__system__` reconnect gate makes in production.
    await refreshServerInfo(pool, `http://127.0.0.1:${server.port}`);
    const recyclesAfterRefresh = countRecycleBegins(infoSpy.mock.calls);

    expect(recyclesAfterRefresh).toBeGreaterThan(recyclesBeforeRefresh);

    // The epoch really did rotate, so the suppression would have been real.
    const secondEpoch = await pool.whenServerInstanceKnown();
    expect(secondEpoch).not.toBe(firstEpoch);

    // User-visible outcome: the doc comes back rather than retrying a frozen
    // claim forever.
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
