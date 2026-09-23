import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, test } from 'vitest';
import { ProviderPool } from '../../src/editor/provider-pool';
import {
  createRestartableServer,
  getServerState,
  pollUntil,
  seedPoolServerInstanceId,
} from './test-harness';

function writeRel(root: string, rel: string, body: string | Uint8Array): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe('restart-with-embed-doc: server restart preserves the embed source bytes exactly once', () => {
  test('![[photo.png]] doc survives restart-recycle with exactly one embed reference', async () => {
    const contentDir = mkdtempSync(join(tmpdir(), 'ok-embed-restart-'));
    writeRel(contentDir, 'photo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    writeRel(contentDir, 'test-doc.md', '# Heading\n\n![[photo.png]]\n');

    let server = await createRestartableServer({ contentDir });
    cleanups.push(() => server.shutdown());

    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());
    await seedPoolServerInstanceId(server, pool);

    pool.open('test-doc');
    pool.setActive('test-doc');
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 10_000, 50);

    const preState = getServerState(server, 'test-doc');
    if (!preState) throw new Error('server has no test-doc loaded pre-restart');
    expect((preState.ytext.toString().match(/!\[\[photo\.png\]\]/g) ?? []).length).toBe(1);

    await wait(500);

    server = await server.killAndRestartOnSamePort({ downtimeMs: 400 });
    cleanups.unshift(() => server.shutdown());
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 15_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 15_000, 50);

    const entry = pool.getActive();
    if (!entry) throw new Error('pool has no active entry after recycle');
    const clientSource = entry.provider.document.getText('source').toString();
    expect((clientSource.match(/!\[\[photo\.png\]\]/g) ?? []).length).toBe(1);

    const postState = getServerState(server, 'test-doc');
    if (!postState) throw new Error('server has no test-doc loaded post-restart');
    expect(postState.ytext.toString()).toBe(clientSource);
  }, 30_000);
});
