/**
 * Acceptance: a hidden-flush racing a server-instance-mismatch recycle must not
 * double-apply the unsynced delta. The recycle's buffer-replay path is the sole
 * carrier of the un-acked edit across the epoch; `flushOnHide` must not add a
 * second write of the same content.
 *
 * The edit is made WHILE DISCONNECTED so it stays unsynced vs the server
 * (`unsyncedChanges > 0`) through the recycle — the exact state where a stray
 * `forceSync` could race the replay. `flushOnHide` is fired across the recycle
 * window; the `mismatchInFlight` guard skips it mid-recycle, and CRDT
 * idempotency backs it up. The oracle is the marker's on-disk count after
 * everything settles (the same duplication oracle the reconnect suite uses).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ProviderPool } from '../../src/editor/provider-pool';
import {
  createRestartableServer,
  pollDiskContentStable,
  pollUntil,
  seedPoolServerInstanceId,
} from './test-harness';

const FIXTURE = `# Race Doc\n\nbase content\n`;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
}, 30_000);

describe('flush-on-hide racing a mismatch recycle', () => {
  it('does not double-apply the unsynced delta (buffer-replay stays exactly-once)', async () => {
    let server = await createRestartableServer();
    cleanups.push(() => server.shutdown());
    const docName = 'flush-race-doc';
    writeFileSync(join(server.contentDir, `${docName}.md`), FIXTURE, 'utf-8');

    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());
    await seedPoolServerInstanceId(server, pool);
    pool.open(docName);
    pool.setActive(docName);
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 10_000, 50);
    await wait(150);

    // Disconnect first, THEN edit — the delta never reaches the server, so it
    // is unsynced (unsyncedChanges > 0) through the recycle.
    const MARKER = 'FLUSHRACEMARKER5f2c';
    server.killNetwork();
    await pollUntil(() => pool.getActive()?.syncState === 'disconnected', 5_000, 50);

    const doc = pool.getActive()?.provider.document;
    if (!doc) throw new Error('active provider missing');
    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.applyDelta([{ insert: MARKER }]);
    paragraph.insert(0, [text]);
    doc.getXmlFragment('default').push([paragraph]);
    expect(pool.getActive()?.provider.unsyncedChanges).toBeGreaterThan(0);

    // Interleave the hidden-flush across the recycle window.
    pool.flushOnHide(); // disconnected: forceSync is a no-op
    server = await server.killAndRestartOnSamePort({ downtimeMs: 400 });
    cleanups.unshift(() => server.shutdown());
    pool.flushOnHide(); // during reconnect/recycle: mismatchInFlight guard skips it
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);
    await pool.awaitMismatchSettled();
    pool.flushOnHide(); // after settle

    // The marker survives in the client doc.
    await pollUntil(
      () =>
        pool.getActive()?.provider.document.getText('source').toString().includes(MARKER) ?? false,
      5_000,
      50,
    );

    // …exactly once on disk (the double-apply bug would write it twice).
    const disk = await pollDiskContentStable(
      join(server.contentDir, `${docName}.md`),
      (content) => content.includes(MARKER),
      { timeoutMs: 8_000, settleMs: 400 },
    );
    expect((disk.match(new RegExp(MARKER, 'g')) ?? []).length).toBe(1);
    // Baseline content is not duplicated either.
    expect((disk.match(/# Race Doc/g) ?? []).length).toBe(1);
  }, 30_000);
});
