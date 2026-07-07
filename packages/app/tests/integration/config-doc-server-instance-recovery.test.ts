/**
 * Config docs (e.g. `.okignore`) duplicate across a server respawn.
 *
 * Root cause: there is no server-side CRDT-binary persistence, so every server
 * boot re-seeds a config doc's Y.Text from disk as FRESH Yjs items. A client
 * that retains its Y.Doc and reconnects to a respawned server union-merges its
 * retained items with the freshly-seeded ones (Yjs does not dedupe identical
 * text), doubling the content — and for `.okignore` (where duplicate lines are
 * valid) the merge persists and compounds per restart.
 *
 * The editor pool defends against this with a `server-instance-mismatch`
 * handshake (claim the epoch in the auth token; the server rejects a stale
 * reconnect at `onAuthenticate` BEFORE any sync). This test verifies the SAME
 * handshake now protects the config-doc providers:
 *
 *   - CONTROL: an UNTOKENED config provider (the pre-fix behavior) union-merges
 *     on respawn → duplicates. Proves the harness reproduces the bug, so the
 *     FIX assertion below is discriminating.
 *   - FIX: a config provider that claims the epoch in its token is REJECTED on
 *     respawn (server-instance-mismatch), so no merge lands → no duplication.
 *     (Production recovery then rebuilds the Y.Doc via the epoch-keyed effect in
 *     `ConfigProvider`; at the bare-provider level the retained single copy is
 *     simply never merged.)
 */

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
      // No token — the pre-fix behavior.
    });
    cleanups.push(() => {
      provider.destroy();
      doc.destroy();
    });

    await waitForSync(provider);
    await pollUntil(() => countFoo(doc) >= 1, 10_000, 50);
    expect(countFoo(doc)).toBe(1);

    // Respawn: new serverInstanceId, same port + contentDir → disk re-seeded.
    server = await server.killAndRestartOnSamePort({ downtimeMs: 200 });

    // The retained doc reconnects (untokened → accepted) and union-merges.
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
      // The fix: claim the current epoch (instance-claim only, no tab identity / branch).
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

    // Respawn: instance B ≠ A. The provider's token still claims A → the server
    // rejects at onAuthenticate before any sync.
    server = await server.killAndRestartOnSamePort({ downtimeMs: 200 });

    await pollUntil(() => rejectedReason !== null, 15_000, 50);
    expect(rejectedReason).toContain('server-instance-mismatch');

    // No union-merge landed: still exactly one copy. (Settle to let any
    // erroneous sync surface before asserting.)
    await wait(500);
    expect(countFoo(doc)).toBe(1);
  }, 30_000);
});
