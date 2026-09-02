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

    pool.flushOnHide();
    server = await server.killAndRestartOnSamePort({ downtimeMs: 400 });
    cleanups.unshift(() => server.shutdown());
    pool.flushOnHide();
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);
    await pool.awaitMismatchSettled();
    pool.flushOnHide();

    await pollUntil(
      () =>
        pool.getActive()?.provider.document.getText('source').toString().includes(MARKER) ?? false,
      5_000,
      50,
    );

    const disk = await pollDiskContentStable(
      join(server.contentDir, `${docName}.md`),
      (content) => content.includes(MARKER),
      { timeoutMs: 8_000, settleMs: 400 },
    );
    expect((disk.match(new RegExp(MARKER, 'g')) ?? []).length).toBe(1);
    expect((disk.match(/# Race Doc/g) ?? []).length).toBe(1);
  }, 30_000);
});
