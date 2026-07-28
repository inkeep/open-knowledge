/**
 * Delete/rename durability — a removed doc must STAY removed.
 *
 * Pins two invariants behind the field report of "resurrecting" docs
 * (deleted markdown files re-materializing on disk with their original
 * content):
 *
 *  1. Teardown-spine store suppression. The API delete/rename spine
 *     (`captureAndCloseDocuments`) unloads the Y.Doc while a debounced
 *     persistence store can still be pending. Hocuspocus force-flushes a
 *     pending store when a doc's last connection closes and never cancels
 *     an armed debounce timer on unload — so without a lifecycle tombstone
 *     on the doc (the watcher's external-delete path sets one before
 *     unloading; the API spine must too) that store fires against the
 *     destroyed-but-readable Y.Doc and rewrites the file that was just
 *     removed.
 *  2. Deletion durability across restart. Every anti-resurrection guard is
 *     per-process; after a restart a client that still holds the doc's Yjs
 *     state (a browser tab's y-indexeddb cache in production) union-syncs
 *     full content into the fresh empty doc and persistence re-creates the
 *     file — including for files deleted while the server was down.
 *
 * All tests drive real inputs through public interfaces (WS client edits,
 * HTTP API, real files on disk) and assert on the user-visible outcome
 * (on-disk file state). Per-test docNames via randomUUID (STOP rule).
 */

import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { parseAuthRejectionWire } from '@inkeep/open-knowledge-server';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  createRestartableServer,
  createTestClient,
  createTestServer,
  getServerState,
  type RestartableServer,
  type TestServer,
} from './test-harness';

/**
 * Assert a file stays absent for the whole watch window. Any appearance is
 * a resurrection — fail immediately with the elapsed time for diagnosis.
 */
async function assertStaysAbsent(filePath: string, windowMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < windowMs) {
    if (existsSync(filePath)) {
      throw new Error(
        `file resurrected ${Date.now() - start}ms after removal: ${filePath}\n` +
          `content: ${JSON.stringify(readFileSync(filePath, 'utf-8').slice(0, 120))}`,
      );
    }
    await wait(100);
  }
}

async function writeMd(port: number, docName: string, markdown: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/api/agent-write-md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docName, markdown, position: 'replace' }),
  });
  if (!res.ok) throw new Error(`agent-write-md failed for ${docName}: ${res.status}`);
}

async function deletePath(port: number, path: string): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/api/delete-path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'file', path }),
  });
  return res.status;
}

async function renamePath(port: number, fromPath: string, toPath: string): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/api/rename-path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'file', fromPath, toPath }),
  });
  return res.status;
}

/** Connect a bare provider (stand-in for a browser tab) and wait for sync. */
async function connectBareClient(
  port: number,
  docName: string,
  doc: Y.Doc,
): Promise<HocuspocusProvider> {
  const provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${port}/collab`,
    name: docName,
    document: doc,
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`initial sync timed out for ${docName}`)),
      10_000,
    );
    provider.on('synced', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return provider;
}

/**
 * Connect a bare provider expecting the removal guard to reject it; return
 * the typed rejection parsed from the wire reason. Fails when the connection
 * is unexpectedly admitted (synced) instead.
 */
async function expectAuthRejection(
  port: number,
  docName: string,
): Promise<ReturnType<typeof parseAuthRejectionWire>> {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${port}/collab`,
    name: docName,
    document: doc,
  });
  try {
    const reason = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`authenticationFailed did not fire for ${docName}`)),
        15_000,
      );
      provider.on('authenticationFailed', (payload: { reason: string }) => {
        clearTimeout(timer);
        resolve(payload.reason);
      });
      provider.on('synced', () => {
        clearTimeout(timer);
        reject(new Error(`connection to ${docName} was unexpectedly admitted`));
      });
    });
    return parseAuthRejectionWire(reason);
  } finally {
    provider.destroy();
    doc.destroy();
  }
}

/**
 * Wait until the doc is quiescent (past the persistence quiescence gate)
 * while the wide store debounce is still pending — the window where a
 * teardown must suppress the armed store rather than rely on the
 * non-quiescence skip.
 */
async function waitIntoArmedQuiescentWindow(): Promise<void> {
  await wait(1200);
}

// ════════════════════════════════════════════════════════════════════════════
// Invariant 1 — teardown-spine store suppression (single server, wide
// debounce so a pending store is deterministically armed at teardown time)
// ════════════════════════════════════════════════════════════════════════════

describe('delete/rename durability — in-flight edit at teardown', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer({ debounce: 2000, maxDebounce: 10_000 });
  }, HARNESS_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await server.cleanup();
  });

  /**
   * The delete flavor of the spine invariant. NOTE: the resurrecting write
   * races the handler's unlink — this harness rig consistently wins the
   * benign ordering (store write lands before the unlink), so on unfixed
   * code this test passes by rig timing rather than by suppression; the
   * production rig loses the race deterministically (field report + the
   * diagnosis repro against a real `ok start` server). The rename test
   * below pins the same spine contract deterministically in CI; this test
   * stands as the delete-flavor regression pin.
   *
   */
  test('API delete during an in-flight edit stays deleted', async () => {
    const docName = `del-armed-${crypto.randomUUID()}`;
    const filePath = join(server.contentDir, `${docName}.md`);
    await writeMd(server.port, docName, '# Victim\n\nbody\n');

    const client = await createTestClient(server.port, docName);
    try {
      // A real user edit through the WS path arms the debounced store.
      const marker = `edit-${crypto.randomUUID()}`;
      client.ytext.insert(client.ytext.length, `\n${marker}\n`);
      const armed = Date.now();
      while (true) {
        const state = getServerState(server, docName);
        if (state?.ytext.toString().includes(marker)) break;
        if (Date.now() - armed > 5000) throw new Error('server never received the edit');
        await wait(25);
      }
      await waitIntoArmedQuiescentWindow();

      // Delete while the store is still pending (debounce=2000ms).
      expect(await deletePath(server.port, docName)).toBe(200);
      expect(existsSync(filePath)).toBe(false);

      // The pending store must not rewrite the file — neither via the
      // last-connection-closed flush nor via the surviving debounce timer.
      await assertStaysAbsent(filePath, 3500);
    } finally {
      await client.cleanup();
    }
  }, 40_000);

  test('API rename during an in-flight edit does not resurrect the old path', async () => {
    const fromName = `ren-armed-${crypto.randomUUID()}`;
    const toName = `ren-armed-${crypto.randomUUID()}`;
    const fromPath = join(server.contentDir, `${fromName}.md`);
    const toPath = join(server.contentDir, `${toName}.md`);
    await writeMd(server.port, fromName, '# Migrant\n\nbody\n');

    const client = await createTestClient(server.port, fromName);
    try {
      const marker = `edit-${crypto.randomUUID()}`;
      client.ytext.insert(client.ytext.length, `\n${marker}\n`);
      const armed = Date.now();
      while (true) {
        const state = getServerState(server, fromName);
        if (state?.ytext.toString().includes(marker)) break;
        if (Date.now() - armed > 5000) throw new Error('server never received the edit');
        await wait(25);
      }
      await waitIntoArmedQuiescentWindow();

      expect(await renamePath(server.port, fromName, toName)).toBe(200);

      // The new path carries the doc (including the in-flight edit — the
      // spine snapshots live content); the old path must never come back.
      expect(existsSync(toPath)).toBe(true);
      expect(readFileSync(toPath, 'utf-8')).toContain(marker);
      await assertStaysAbsent(fromPath, 3500);
    } finally {
      await client.cleanup();
    }
  }, 40_000);
});

// ════════════════════════════════════════════════════════════════════════════
// Invariant 2 — deletion durability across restart (same-port restart with a
// live client holding the doc's full Yjs state, like a browser tab's IDB)
// ════════════════════════════════════════════════════════════════════════════

describe('delete durability — across server restart with a stale client', () => {
  test('API delete survives a restart when a stale client reconnects', async () => {
    let rs: RestartableServer = await createRestartableServer();
    const docName = `restart-del-${crypto.randomUUID()}`;
    const filePath = join(rs.contentDir, `${docName}.md`);
    const marker = `cached-${crypto.randomUUID()}`;
    await writeMd(rs.port, docName, `# Cached\n\n${marker}\n`);

    const clientDoc = new Y.Doc();
    const provider = await connectBareClient(rs.port, docName, clientDoc);
    try {
      expect(clientDoc.getText('source').toString()).toContain(marker);

      expect(await deletePath(rs.port, docName)).toBe(200);
      expect(existsSync(filePath)).toBe(false);

      // Restart on the same port. The client keeps its Y.Doc (full content)
      // and auto-reconnects — production shape: a browser tab whose
      // y-indexeddb cache holds the deleted doc.
      rs = await rs.killAndRestartOnSamePort({ downtimeMs: 800 });

      // The deletion must hold: the reconnecting client's cached state must
      // not be admitted as a first write that re-creates the file.
      await assertStaysAbsent(filePath, 6000);
    } finally {
      provider.destroy();
      clientDoc.destroy();
      await rs.shutdown();
    }
  }, 60_000);

  /**
   * A journaled rename-redirect must survive the boot deleted-while-down
   * inference — never get downgraded to a hard delete. The stale state this
   * constructs is real: watcher-observed renames persist the backlink cache
   * on a debounced save (API renames save directly), so a rename landing
   * inside the debounce window before a shutdown leaves the persisted cache
   * still holding the OLD docName while the removal journal (flushed
   * synchronously on destroy) correctly holds `renamed`. At the next boot
   * the inference sees the old name as "gone from disk"; it must not
   * clobber the strictly-more-informative journaled redirect (mirror of the
   * watcher unpaired-delete peek-guard). The test reproduces the window
   * deterministically by restoring the server-authored pre-rename cache
   * bytes after shutdown — byte-identical to what the un-flushed debounce
   * leaves behind.
   *
   */
  test('journaled rename-redirect survives the boot deleted-while-down inference (no downgrade to doc-deleted)', async () => {
    const contentDirHolder: { dir: string | null } = { dir: null };
    let rs: RestartableServer | null = await createRestartableServer({ keepContentDir: true });
    contentDirHolder.dir = rs.contentDir;
    const oldName = `pre-restart-ren-${crypto.randomUUID()}`;
    const newName = `pre-restart-ren-${crypto.randomUUID()}`;
    try {
      await writeMd(rs.port, oldName, '# Migrant\n\nbody\n');

      // Steady state: the persisted backlink cache knows the OLD name.
      const cachePath = join(rs.contentDir, '.ok', 'local', 'cache', 'main', 'backlinks.json');
      const cacheDeadline = Date.now() + 10_000;
      while (true) {
        if (existsSync(cachePath) && readFileSync(cachePath, 'utf-8').includes(oldName)) break;
        if (Date.now() > cacheDeadline) throw new Error('backlink cache never persisted the doc');
        await wait(100);
      }
      const staleCacheBytes = readFileSync(cachePath);

      // Rename (journals `renamed`; destroy flushes it), shut down, then
      // restore the pre-rename cache bytes — the on-disk state a rename
      // inside the debounced-save window leaves behind.
      expect(await renamePath(rs.port, oldName, newName)).toBe(200);
      const port = rs.port;
      await rs.shutdown();
      rs = null;
      writeFileSync(cachePath, staleCacheBytes);

      rs = await createRestartableServer({
        contentDir: contentDirHolder.dir,
        keepContentDir: true,
        port,
      });

      // The old path stays gone and a stale tab is redirected — not
      // hard-rejected. Exercise the FULL WS dispatch chain (a real provider
      // connect) and assert on the typed rejection fields.
      expect(existsSync(join(rs.contentDir, `${oldName}.md`))).toBe(false);
      expect(existsSync(join(rs.contentDir, `${newName}.md`))).toBe(true);

      const rejection = await expectAuthRejection(rs.port, oldName);
      expect(rejection.kind).toBe('rename-redirect');
      expect(rejection.payload).toBe(newName);
    } finally {
      if (rs) await rs.shutdown();
      if (contentDirHolder.dir) rmSync(contentDirHolder.dir, { recursive: true, force: true });
    }
  }, 60_000);

  /**
   * The inverse boot case: a file RE-CREATED at a removed docName while the
   * server was down means the durable tombstone is stale — disk is truth at
   * boot. Without the origin-existence sweep, the journaled rename-redirect
   * would misdirect connections away from a doc whose file exists.
   *
   */
  test('a doc re-created at the old path while the server was down is admitted after boot', async () => {
    const contentDirHolder: { dir: string | null } = { dir: null };
    let rs: RestartableServer | null = await createRestartableServer({ keepContentDir: true });
    contentDirHolder.dir = rs.contentDir;
    const oldName = `downtime-recreate-${crypto.randomUUID()}`;
    const newName = `downtime-recreate-${crypto.randomUUID()}`;
    const recreatedMarker = `recreated-${crypto.randomUUID()}`;
    try {
      await writeMd(rs.port, oldName, '# Original\n\nbody\n');
      // Rename journals the redirect; destroy flushes it durably.
      expect(await renamePath(rs.port, oldName, newName)).toBe(200);
      const port = rs.port;
      await rs.shutdown();
      rs = null;

      // While the server is down, the user re-creates a file at the OLD path.
      writeFileSync(
        join(contentDirHolder.dir, `${oldName}.md`),
        `# Recreated\n\n${recreatedMarker}\n`,
      );

      rs = await createRestartableServer({
        contentDir: contentDirHolder.dir,
        keepContentDir: true,
        port,
      });

      // The re-created doc must be reachable — a real client connects, is
      // admitted, and syncs the re-created content (no stale redirect).
      const clientDoc = new Y.Doc();
      const provider = await connectBareClient(rs.port, oldName, clientDoc);
      try {
        const deadline = Date.now() + 10_000;
        while (!clientDoc.getText('source').toString().includes(recreatedMarker)) {
          if (Date.now() > deadline)
            throw new Error('admitted client never saw re-created content');
          await wait(100);
        }
      } finally {
        provider.destroy();
        clientDoc.destroy();
      }
    } finally {
      if (rs) await rs.shutdown();
      if (contentDirHolder.dir) rmSync(contentDirHolder.dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('external rm during downtime survives the next start when a stale client reconnects', async () => {
    let rs: RestartableServer = await createRestartableServer();
    const docName = `downtime-del-${crypto.randomUUID()}`;
    const filePath = join(rs.contentDir, `${docName}.md`);
    const marker = `cached-${crypto.randomUUID()}`;
    await writeMd(rs.port, docName, `# Cached\n\n${marker}\n`);

    const clientDoc = new Y.Doc();
    const provider = await connectBareClient(rs.port, docName, clientDoc);
    try {
      expect(clientDoc.getText('source').toString()).toContain(marker);

      // Steady-state precondition: the deleted-while-down inference reads
      // the persisted backlink cache as the last-known doc set, and the
      // cache save is debounced — wait for the doc to land in the persisted
      // cache (as it long since has for any real deployment) before
      // crashing.
      const cachePath = join(rs.contentDir, '.ok', 'local', 'cache', 'main', 'backlinks.json');
      const cacheDeadline = Date.now() + 10_000;
      while (true) {
        if (existsSync(cachePath) && readFileSync(cachePath, 'utf-8').includes(docName)) break;
        if (Date.now() > cacheDeadline) {
          throw new Error('backlink cache never persisted the doc');
        }
        await wait(100);
      }

      // Crash the server, delete the file while it is DOWN (the server
      // never observes the unlink), then restart on the same port.
      const restarting = rs.killAndRestartOnSamePort({ downtimeMs: 900 });
      await wait(250);
      unlinkSync(filePath);
      rs = await restarting;

      // The deletion performed during downtime must hold across the boot:
      // the reconnecting client's cached state must not re-create the file.
      await assertStaysAbsent(filePath, 6000);
    } finally {
      provider.destroy();
      clientDoc.destroy();
      await rs.shutdown();
    }
  }, 60_000);
});
