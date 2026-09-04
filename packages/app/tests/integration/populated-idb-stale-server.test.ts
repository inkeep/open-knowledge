import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { ProviderPool } from '../../src/editor/provider-pool';
import { createRestartableServer, pollUntil, seedClientPersistenceState } from './test-harness';

const CURRENT_SERVER_MARKDOWN = `# Current Server Doc

Paragraph with unique marker T14-CURRENT.

[[current-sibling]]
`;

const STALE_MARKER = 'T14-STALE-FROM-PRIOR-SESSION';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe('T14: populated IDB meets stale server instance', () => {
  test('stale IDB + wrong serverInstanceId: authenticationFailed clears IDB, fresh sync has no stale bleed', async () => {
    const server = await createRestartableServer();
    cleanups.push(() => server.shutdown());
    writeFileSync(join(server.contentDir, 'test-doc.md'), CURRENT_SERVER_MARKDOWN, 'utf-8');
    await wait(250);

    const STALE_INSTANCE_ID = 't14-stale-instance-id-mismatch-xyz';
    const seedDoc = new Y.Doc();
    seedDoc.getText('source').insert(0, STALE_MARKER);
    const staleBytes = Y.encodeStateAsUpdate(seedDoc);
    seedDoc.destroy();

    await seedClientPersistenceState('test-doc', [staleBytes], STALE_INSTANCE_ID);

    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());
    pool.setExpectedServerInstanceId(STALE_INSTANCE_ID);

    pool.open('test-doc');
    pool.setActive('test-doc');

    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 15_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 15_000, 50);

    await wait(300);

    const entry = pool.getActive();
    if (!entry) throw new Error('pool has no active entry after mismatch-recycle');
    const clientText = entry.provider.document.getText('source').toString();

    expect((clientText.match(/T14-CURRENT/g) ?? []).length).toBe(1);
    expect((clientText.match(/\[\[current-sibling\]\]/g) ?? []).length).toBe(1);
    expect((clientText.match(new RegExp(STALE_MARKER, 'g')) ?? []).length).toBe(0);
  }, 30_000);
});
