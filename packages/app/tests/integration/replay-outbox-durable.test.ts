/**
 * Durable replay-outbox across a real `server-instance-mismatch` recycle.
 *
 * The in-memory buffer loses an unsynced edit if the tab dies inside the
 * recycle window. The durable outbox (`replay-outbox.ts`) closes that window:
 * it is written to a SEPARATE IndexedDB database BEFORE `clearData()` wipes the
 * y-indexeddb store, and consumed on reopen.
 *
 * SCOPE — what this test does and does not establish. It drives the real
 * mismatch (kill network → restart server on the same port → auth reject →
 * recycle) with an unsynced edit, in the SAME tab. The replay prefers the RAM
 * buffer and reads the outbox only as a fallback, so on a same-tab recycle the
 * buffer is always populated and it, not the outbox, is what carries the edit
 * across. The outbox's role here is its LIFECYCLE — written before `clearData`,
 * survives it, and is consumed rather than orphaned — which is exactly what the
 * assertions below check. The carrier-of-last-resort behavior (a tab that dies
 * mid-recycle, where the outbox is the only carrier) needs a rig that discards
 * the RAM buffer and is not covered here.
 *
 * Asserts:
 *
 *   1. The edit survives on disk exactly once (no regression from the durable
 *      layer, no duplication).
 *   2. The durable outbox for the doc was WRITTEN during the mismatch (its
 *      database exists afterward, proving it survived `clearData`) and its
 *      record was CONSUMED by the replay (no orphan buffer that a later open
 *      could re-apply — consume-first in the real flow).
 */

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

/** Outbox databases whose key ends in the given docName. */
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

    // A local WYSIWYG-style edit — a real Y.js mutation under the client's
    // clientID, so it produces an unsynced delta the recycle must carry.
    const marker = 'DURABLE-OUTBOX-MARKER-7b21';
    const firstProvider = pool.getActive()?.provider;
    if (!firstProvider) throw new Error('expected active provider');
    const paragraph = new Y.XmlElement('paragraph');
    const xmlText = new Y.XmlText();
    xmlText.applyDelta([{ insert: marker }]);
    paragraph.insert(0, [xmlText]);
    firstProvider.document.getXmlFragment('default').push([paragraph]);

    // Let the edit reach the server's in-memory Y.Doc, then kill the network
    // BEFORE the persistence debounce flushes it to disk — the fresh server
    // then rebuilds from a marker-less disk, so the durable outbox is what
    // carries the edit across the recycle.
    await pollUntil(() => firstProvider.unsyncedChanges === 0, 180, 10);
    server.killNetwork();
    await pollUntil(() => pool.getActive()?.syncState === 'disconnected', 5_000, 25);

    server = await server.killAndRestartOnSamePort({ downtimeMs: 400 });
    cleanups.unshift(() => server.shutdown());
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 15_000, 50);

    // The edit survives in the fresh client Y.Doc.
    await pollUntil(
      () =>
        pool.getActive()?.provider.document.getText('source').toString().includes(marker) ?? false,
      5_000,
      50,
    );

    // The edit lands back on disk exactly once (no duplication).
    const afterRestart = await pollDiskContentStable(
      join(server.contentDir, `${docName}.md`),
      (c) => c.includes(marker),
      { timeoutMs: 8_000, settleMs: 400 },
    );
    expect((afterRestart.match(new RegExp(marker, 'g')) ?? []).length).toBe(1);
    expect((afterRestart.match(/# Durable Doc/g) ?? []).length).toBe(1);

    // The durable outbox was written during the mismatch (its database exists,
    // so it survived clearData) and its record was consumed by the replay —
    // no orphan buffer remains for a later open to re-apply.
    const outboxDbs = await outboxDbsForDoc(docName);
    expect(outboxDbs.length).toBeGreaterThanOrEqual(1);
    for (const dbName of outboxDbs) {
      const segments = dbName.split(':');
      const branch = segments[1] ?? '';
      expect(await readReplayOutboxEntry(branch, docName)).toBeNull();
    }

    const finalOnDisk = readFileSync(join(server.contentDir, `${docName}.md`), 'utf-8');
    expect((finalOnDisk.match(new RegExp(marker, 'g')) ?? []).length).toBe(1);
  }, 30_000);
});
