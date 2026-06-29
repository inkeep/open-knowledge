import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { CONFIG_DOC_NAME_OKIGNORE } from '@inkeep/open-knowledge-core';
import * as Y from 'yjs';
import { buildAuthToken } from '../../src/lib/auth-token';
import { createRestartableServer, pollUntil, waitForSync } from './test-harness';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function countFoo(doc: Y.Doc): number {
  return (doc.getText('source').toString().match(/foo/g) ?? []).length;
}

describe('PRD-6881: config-doc server-instance recovery', () => {
  test('CONTROL: untokened config provider union-merges (duplicates) across a respawn', async () => {
    let server = await createRestartableServer();
    cleanups.push(() => server.shutdown());
    writeFileSync(join(server.contentDir, '.okignore'), 'foo\n', 'utf-8');

    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${server.port}/collab`,
      name: CONFIG_DOC_NAME_OKIGNORE,
      document: doc,
    });
    cleanups.push(() => {
      provider.destroy();
      doc.destroy();
    });

    await waitForSync(provider);
    await pollUntil(() => countFoo(doc) >= 1, 10_000, 50);
    expect(countFoo(doc)).toBe(1);

    server = await server.killAndRestartOnSamePort({ downtimeMs: 200 });

    await pollUntil(() => countFoo(doc) >= 2, 15_000, 50);
    expect(countFoo(doc)).toBeGreaterThanOrEqual(2);
  }, 30_000);

  test('FIX: epoch-claiming config provider is rejected on respawn and does not duplicate', async () => {
    let server = await createRestartableServer();
    cleanups.push(() => server.shutdown());
    writeFileSync(join(server.contentDir, '.okignore'), 'foo\n', 'utf-8');

    const instanceA = server.instance.serverInstanceId;
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${server.port}/collab`,
      name: CONFIG_DOC_NAME_OKIGNORE,
      document: doc,
      token: buildAuthToken(null, instanceA, null),
    });
    cleanups.push(() => {
      provider.destroy();
      doc.destroy();
    });

    let rejectedReason: string | null = null;
    provider.on('authenticationFailed', ({ reason }: { reason: string }) => {
      rejectedReason = reason;
    });

    await waitForSync(provider);
    await pollUntil(() => countFoo(doc) >= 1, 10_000, 50);
    expect(countFoo(doc)).toBe(1);

    server = await server.killAndRestartOnSamePort({ downtimeMs: 200 });

    await pollUntil(() => rejectedReason !== null, 15_000, 50);
    expect(rejectedReason).toContain('server-instance-mismatch');

    await wait(500);
    expect(countFoo(doc)).toBe(1);
  }, 30_000);
});
