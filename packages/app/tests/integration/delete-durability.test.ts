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

async function waitIntoArmedQuiescentWindow(): Promise<void> {
  await wait(1200);
}

describe('delete/rename durability — in-flight edit at teardown', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer({ debounce: 2000, maxDebounce: 10_000 });
  }, HARNESS_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await server.cleanup();
  });

  test('API delete during an in-flight edit stays deleted', async () => {
    const docName = `del-armed-${crypto.randomUUID()}`;
    const filePath = join(server.contentDir, `${docName}.md`);
    await writeMd(server.port, docName, '# Victim\n\nbody\n');

    const client = await createTestClient(server.port, docName);
    try {
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

      expect(await deletePath(server.port, docName)).toBe(200);
      expect(existsSync(filePath)).toBe(false);

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

      expect(existsSync(toPath)).toBe(true);
      expect(readFileSync(toPath, 'utf-8')).toContain(marker);
      await assertStaysAbsent(fromPath, 3500);
    } finally {
      await client.cleanup();
    }
  }, 40_000);
});

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

      rs = await rs.killAndRestartOnSamePort({ downtimeMs: 800 });

      await assertStaysAbsent(filePath, 6000);
    } finally {
      provider.destroy();
      clientDoc.destroy();
      await rs.shutdown();
    }
  }, 60_000);

  test('journaled rename-redirect survives the boot deleted-while-down inference (no downgrade to doc-deleted)', async () => {
    const contentDirHolder: { dir: string | null } = { dir: null };
    let rs: RestartableServer | null = await createRestartableServer({ keepContentDir: true });
    contentDirHolder.dir = rs.contentDir;
    const oldName = `pre-restart-ren-${crypto.randomUUID()}`;
    const newName = `pre-restart-ren-${crypto.randomUUID()}`;
    try {
      await writeMd(rs.port, oldName, '# Migrant\n\nbody\n');

      const cachePath = join(rs.contentDir, '.ok', 'local', 'cache', 'main', 'backlinks.json');
      const cacheDeadline = Date.now() + 10_000;
      while (true) {
        if (existsSync(cachePath) && readFileSync(cachePath, 'utf-8').includes(oldName)) break;
        if (Date.now() > cacheDeadline) throw new Error('backlink cache never persisted the doc');
        await wait(100);
      }
      const staleCacheBytes = readFileSync(cachePath);

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

  test('a doc re-created at the old path while the server was down is admitted after boot', async () => {
    const contentDirHolder: { dir: string | null } = { dir: null };
    let rs: RestartableServer | null = await createRestartableServer({ keepContentDir: true });
    contentDirHolder.dir = rs.contentDir;
    const oldName = `downtime-recreate-${crypto.randomUUID()}`;
    const newName = `downtime-recreate-${crypto.randomUUID()}`;
    const recreatedMarker = `recreated-${crypto.randomUUID()}`;
    try {
      await writeMd(rs.port, oldName, '# Original\n\nbody\n');
      expect(await renamePath(rs.port, oldName, newName)).toBe(200);
      const port = rs.port;
      await rs.shutdown();
      rs = null;

      writeFileSync(
        join(contentDirHolder.dir, `${oldName}.md`),
        `# Recreated\n\n${recreatedMarker}\n`,
      );

      rs = await createRestartableServer({
        contentDir: contentDirHolder.dir,
        keepContentDir: true,
        port,
      });

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

      const cachePath = join(rs.contentDir, '.ok', 'local', 'cache', 'main', 'backlinks.json');
      const cacheDeadline = Date.now() + 10_000;
      while (true) {
        if (existsSync(cachePath) && readFileSync(cachePath, 'utf-8').includes(docName)) break;
        if (Date.now() > cacheDeadline) {
          throw new Error('backlink cache never persisted the doc');
        }
        await wait(100);
      }

      const restarting = rs.killAndRestartOnSamePort({ downtimeMs: 900 });
      await wait(250);
      unlinkSync(filePath);
      rs = await restarting;

      await assertStaysAbsent(filePath, 6000);
    } finally {
      provider.destroy();
      clientDoc.destroy();
      await rs.shutdown();
    }
  }, 60_000);
});
