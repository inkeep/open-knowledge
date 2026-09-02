import './idb-preload';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, test } from 'vitest';
import { ProviderPool } from '../../src/editor/provider-pool';
import {
  clientIdsInDoc,
  createRestartableServer,
  pollDiskContentStable,
  pollUntil,
  seedPoolServerInstanceId,
} from './test-harness';

const CONTENT_A = `# Version A

Content A only.

[[a-only-sibling]]
`;

const CONTENT_B = `# Version B

Content B only.

[[b-only-sibling]]
`;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
}, 30_000);

describe('T9: External disk edit during server restart', () => {
  test('REPRO: disk flipped from A to B during downtime, tab open — no content-A bleed', async () => {
    let server = await createRestartableServer();
    cleanups.push(() => server.shutdown());

    writeFileSync(join(server.contentDir, 'test-doc.md'), CONTENT_A, 'utf-8');

    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());
    await seedPoolServerInstanceId(server, pool);

    pool.open('test-doc');
    pool.setActive('test-doc');
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 10_000, 50);
    await wait(150);

    const firstProvider = pool.getActive()?.provider;
    if (!firstProvider) throw new Error('no provider post-sync');

    const preText = firstProvider.document.getText('source').toString();
    expect(preText.includes('a-only-sibling')).toBe(true);

    const preClientIds = clientIdsInDoc(firstProvider.document);

    const contentDir = server.contentDir;

    server.killNetwork();

    await pollUntil(() => pool.getActive()?.syncState === 'disconnected', 3000, 50);

    writeFileSync(join(contentDir, 'test-doc.md'), CONTENT_B, 'utf-8');
    await wait(200);

    server = await server.killAndRestartOnSamePort({ downtimeMs: 300 });
    cleanups.unshift(() => server.shutdown());

    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);

    await wait(500);

    const activeEntry = pool.getActive();
    if (!activeEntry) throw new Error('pool has no active entry post-restart');
    const activeProvider = activeEntry.provider;
    const postClientIds = clientIdsInDoc(activeProvider.document);
    const grewBy = postClientIds.size - preClientIds.size;

    const postText = activeProvider.document.getText('source').toString();
    const aSiblings = (postText.match(/\[\[a-only-sibling\]\]/g) ?? []).length;
    const bSiblings = (postText.match(/\[\[b-only-sibling\]\]/g) ?? []).length;
    const aHeading = (postText.match(/# Version A/g) ?? []).length;
    const bHeading = (postText.match(/# Version B/g) ?? []).length;

    console.log('[T9] marker counts', {
      aSiblings,
      bSiblings,
      aHeading,
      bHeading,
      grewBy,
      clientIdSetSize: postClientIds.size,
    });

    expect(bSiblings).toBe(1);
    expect(bHeading).toBe(1);
    expect(aSiblings).toBe(0);
    expect(aHeading).toBe(0);

    const diskAfter = await pollDiskContentStable(
      join(contentDir, 'test-doc.md'),
      (c) => c.includes('b-only-sibling'),
      { timeoutMs: 5000, settleMs: 300 },
    );
    expect((diskAfter.match(/b-only-sibling/g) ?? []).length).toBe(1);
    expect((diskAfter.match(/a-only-sibling/g) ?? []).length).toBe(0);
  }, 30_000);
});
