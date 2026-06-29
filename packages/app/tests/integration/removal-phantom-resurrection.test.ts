import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import {
  getMetrics,
  HocuspocusAuthRejection,
  parseAuthRejectionWire,
  resetMetrics,
} from '@inkeep/open-knowledge-server';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, type TestServer } from './test-harness';

async function pollUntilAsync(
  predicate: () => Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await wait(intervalMs);
  }
  throw new Error(`pollUntilAsync timed out after ${timeoutMs}ms`);
}

interface RemovalRedirectGuardLike {
  onAuthenticate: (payload: { documentName: string }) => Promise<void>;
}

function getRemovalRedirectGuard(server: TestServer): RemovalRedirectGuardLike {
  const ext = server.instance.hocuspocus.configuration.extensions.find(
    (e) => (e as { __kind?: string }).__kind === 'removal-redirect-guard',
  ) as RemovalRedirectGuardLike | undefined;
  if (!ext) throw new Error('expected removalRedirectGuard on hocuspocus.configuration');
  return ext;
}

async function runAuthGuard(
  server: TestServer,
  documentName: string,
): Promise<HocuspocusAuthRejection | null> {
  const ext = getRemovalRedirectGuard(server);
  try {
    await ext.onAuthenticate({ documentName });
    return null;
  } catch (err) {
    if (err instanceof HocuspocusAuthRejection) return err;
    throw err;
  }
}

async function renamePath(
  port: number,
  fromPath: string,
  toPath: string,
): Promise<{ status: number; body: { ok: boolean; renamed?: unknown[] } }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/rename-path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'file', fromPath, toPath }),
  });
  const body = (await res.json()) as { ok: boolean; renamed?: unknown[] };
  return { status: res.status, body };
}

async function deletePath(
  port: number,
  path: string,
  kind: 'file' | 'folder' = 'file',
): Promise<{ status: number; body: { ok: boolean; deletedDocNames?: string[] } }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/delete-path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, path }),
  });
  const body = (await res.json()) as { ok: boolean; deletedDocNames?: string[] };
  return { status: res.status, body };
}

async function createPage(
  port: number,
  path: string,
): Promise<{ status: number; body: { ok: boolean; docName?: string } }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/create-page`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  const body = (await res.json()) as { ok: boolean; docName?: string };
  return { status: res.status, body };
}

async function seedDoc(server: TestServer, docName: string, content = '# seed\n'): Promise<void> {
  writeFileSync(join(server.contentDir, `${docName}.md`), content, 'utf-8');
  await pollUntilAsync(async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`);
    if (!res.ok) return false;
    const data = (await res.json()) as { documents?: Array<{ docName: string }> };
    return data.documents?.some((d) => d.docName === docName) === true;
  }, 8000);
}

async function pollUntilGuardSettled(
  server: TestServer,
  docName: string,
  expected: 'admit' | 'reject',
  timeoutMs = 5000,
): Promise<HocuspocusAuthRejection | null> {
  let last: HocuspocusAuthRejection | null = null;
  await pollUntilAsync(async () => {
    last = await runAuthGuard(server, docName);
    return expected === 'admit' ? last === null : last !== null;
  }, timeoutMs);
  return last;
}

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

beforeEach(() => {
  resetMetrics();
});

describe('removalRedirectGuard — auth-rejection mechanism', () => {
  test('QA-001: rename A → B rejects any reconnect to A and prevents resurrection', async () => {
    const fromName = `rename-${crypto.randomUUID()}`;
    const toName = `rename-${crypto.randomUUID()}`;
    await seedDoc(server, fromName);

    const res = await renamePath(server.port, fromName, toName);
    expect(res.status).toBe(200);

    const rejection = await runAuthGuard(server, fromName);
    expect(rejection).toBeInstanceOf(HocuspocusAuthRejection);
    const parsed = parseAuthRejectionWire((rejection as HocuspocusAuthRejection).reason);
    expect(parsed.kind).toBe('rename-redirect');
    expect(parsed.payload).toBe(toName);

    expect(existsSync(join(server.contentDir, `${fromName}.md`))).toBe(false);
    expect(existsSync(join(server.contentDir, `${toName}.md`))).toBe(true);
    expect(getMetrics().authRenameRedirectCount).toBeGreaterThanOrEqual(1);
    expect(getMetrics().authDocDeletedCount).toBe(0);
  }, 30_000);

  test('QA-002: delete A routes a connection to A through doc-deleted', async () => {
    const docName = `delete-${crypto.randomUUID()}`;
    await seedDoc(server, docName);

    const res = await deletePath(server.port, docName);
    expect(res.status).toBe(200);

    const rejection = await runAuthGuard(server, docName);
    expect(rejection).toBeInstanceOf(HocuspocusAuthRejection);
    const parsed = parseAuthRejectionWire((rejection as HocuspocusAuthRejection).reason);
    expect(parsed.kind).toBe('doc-deleted');
    expect(parsed.payload).toBeUndefined();

    expect(existsSync(join(server.contentDir, `${docName}.md`))).toBe(false);
    expect(getMetrics().authDocDeletedCount).toBeGreaterThanOrEqual(1);
  }, 30_000);

  test('QA-003: rename then create-page at OLD path admits (file-existence-first)', async () => {
    const fromName = `recreate-${crypto.randomUUID()}`;
    const toName = `recreate-${crypto.randomUUID()}`;
    await seedDoc(server, fromName);
    await renamePath(server.port, fromName, toName);

    const created = await createPage(server.port, `${fromName}.md`);
    expect(created.status).toBe(200);
    expect(created.body.docName).toBe(fromName);

    const rejection = await runAuthGuard(server, fromName);
    expect(rejection).toBeNull();
    expect(existsSync(join(server.contentDir, `${fromName}.md`))).toBe(true);
  }, 30_000);

  test('QA-004: delete then create-page at deleted path admits', async () => {
    const docName = `delete-recreate-${crypto.randomUUID()}`;
    await seedDoc(server, docName);
    await deletePath(server.port, docName);

    const created = await createPage(server.port, `${docName}.md`);
    expect(created.status).toBe(200);

    const rejection = await runAuthGuard(server, docName);
    expect(rejection).toBeNull();
    expect(existsSync(join(server.contentDir, `${docName}.md`))).toBe(true);
  }, 30_000);

  test('QA-005: chained renames A → B → C reject any reconnect to A (no resurrection)', async () => {
    const a = `chain-${crypto.randomUUID()}`;
    const b = `chain-${crypto.randomUUID()}`;
    const c = `chain-${crypto.randomUUID()}`;
    await seedDoc(server, a);

    expect((await renamePath(server.port, a, b)).status).toBe(200);
    expect((await renamePath(server.port, b, c)).status).toBe(200);

    const rejection = await runAuthGuard(server, a);
    expect(rejection).toBeInstanceOf(HocuspocusAuthRejection);
    const parsed = parseAuthRejectionWire((rejection as HocuspocusAuthRejection).reason);
    expect(parsed.kind).toBe('rename-redirect');
    expect(parsed.payload).toBe(c);

    expect(existsSync(join(server.contentDir, `${a}.md`))).toBe(false);
    expect(existsSync(join(server.contentDir, `${b}.md`))).toBe(false);
    expect(existsSync(join(server.contentDir, `${c}.md`))).toBe(true);
  }, 30_000);

  test('QA-016: system + config docNames bypass the guard entirely', async () => {
    const systemDoc = '__system__';
    const configDoc = '__config__/project';

    expect(await runAuthGuard(server, systemDoc)).toBeNull();
    expect(await runAuthGuard(server, configDoc)).toBeNull();
    expect(getMetrics().authRenameRedirectCount).toBe(0);
    expect(getMetrics().authDocDeletedCount).toBe(0);
  });
});

describe('RecentlyRemovedDocs — cache lifecycle', () => {
  test('QA-008 spine populate: rename via /api/rename-path arms the cache as renamed', async () => {
    const fromName = `spine-${crypto.randomUUID()}`;
    const toName = `spine-${crypto.randomUUID()}`;
    await seedDoc(server, fromName);
    await renamePath(server.port, fromName, toName);

    const rejection = await runAuthGuard(server, fromName);
    expect(rejection).toBeInstanceOf(HocuspocusAuthRejection);
    const parsed = parseAuthRejectionWire((rejection as HocuspocusAuthRejection).reason);
    expect(parsed.kind).toBe('rename-redirect');
    expect(parsed.payload).toBe(toName);
  }, 30_000);

  test('peek-guard: watcher unpaired-delete after spine rename does not downgrade entry', async () => {
    const wins: Array<'rename-redirect' | 'doc-deleted'> = [];
    for (let i = 0; i < 10; i++) {
      const fromName = `peek-guard-${crypto.randomUUID()}`;
      const toName = `peek-guard-${crypto.randomUUID()}`;
      await seedDoc(server, fromName);
      await renamePath(server.port, fromName, toName);
      await wait(120);
      const rejection = await runAuthGuard(server, fromName);
      const parsed = parseAuthRejectionWire((rejection as HocuspocusAuthRejection).reason);
      wins.push(parsed.kind as 'rename-redirect' | 'doc-deleted');
    }
    expect(wins.every((k) => k === 'rename-redirect')).toBe(true);
  }, 30_000);

  test('QA-009 handleDeletePath populate: cache holds deleted entry after /api/delete-path', async () => {
    const docName = `delete-populate-${crypto.randomUUID()}`;
    await seedDoc(server, docName);
    await deletePath(server.port, docName);

    const rejection = await runAuthGuard(server, docName);
    expect(rejection).toBeInstanceOf(HocuspocusAuthRejection);
    expect(parseAuthRejectionWire((rejection as HocuspocusAuthRejection).reason).kind).toBe(
      'doc-deleted',
    );
  }, 30_000);

  test('QA-010 create-page invalidation: stale renamed entry dropped on recreate', async () => {
    const docName = `invalidate-${crypto.randomUUID()}`;
    const renamedTarget = `invalidate-${crypto.randomUUID()}`;
    await seedDoc(server, docName);
    await renamePath(server.port, docName, renamedTarget);

    expect(await runAuthGuard(server, docName)).toBeInstanceOf(HocuspocusAuthRejection);

    expect((await createPage(server.port, `${docName}.md`)).status).toBe(200);

    expect(await runAuthGuard(server, docName)).toBeNull();
  }, 30_000);

  test('QA-008 watcher rename: external fs.renameSync arms the cache via reconcile (any reject kind)', async () => {
    const fromName = `watch-rename-${crypto.randomUUID()}`;
    const toName = `watch-rename-${crypto.randomUUID()}`;
    await seedDoc(server, fromName);

    renameSync(join(server.contentDir, `${fromName}.md`), join(server.contentDir, `${toName}.md`));

    const rejection = await pollUntilGuardSettled(server, fromName, 'reject');
    expect(rejection).toBeInstanceOf(HocuspocusAuthRejection);
    const parsed = parseAuthRejectionWire((rejection as HocuspocusAuthRejection).reason);
    expect(['rename-redirect', 'doc-deleted']).toContain(parsed.kind);
    expect(existsSync(join(server.contentDir, `${fromName}.md`))).toBe(false);
    expect(existsSync(join(server.contentDir, `${toName}.md`))).toBe(true);
  }, 30_000);

  test('QA-009 watcher delete: external fs.unlinkSync arms the cache via reconcile', async () => {
    const docName = `watch-delete-${crypto.randomUUID()}`;
    await seedDoc(server, docName);

    unlinkSync(join(server.contentDir, `${docName}.md`));

    const rejection = await pollUntilGuardSettled(server, docName, 'reject');
    expect(parseAuthRejectionWire((rejection as HocuspocusAuthRejection).reason).kind).toBe(
      'doc-deleted',
    );
  }, 30_000);

  test('QA-010 watcher add invalidation: external write at a stale name clears the entry', async () => {
    const docName = `watch-add-${crypto.randomUUID()}`;
    const successor = `watch-add-${crypto.randomUUID()}`;
    await seedDoc(server, docName);
    await renamePath(server.port, docName, successor);

    expect(await runAuthGuard(server, docName)).toBeInstanceOf(HocuspocusAuthRejection);

    writeFileSync(join(server.contentDir, `${docName}.md`), '# resurrected\n', 'utf-8');

    await pollUntilGuardSettled(server, docName, 'admit');
  }, 30_000);

  test('QA-011 sidebar handleDelete IDB-clear: server-side round-trip prevents resurrection', async () => {
    const docName = `sidebar-${crypto.randomUUID()}`;
    await seedDoc(server, docName);

    expect((await deletePath(server.port, docName)).status).toBe(200);

    const rejection = await runAuthGuard(server, docName);
    expect(rejection).toBeInstanceOf(HocuspocusAuthRejection);
    expect(parseAuthRejectionWire((rejection as HocuspocusAuthRejection).reason).kind).toBe(
      'doc-deleted',
    );
    expect(existsSync(join(server.contentDir, `${docName}.md`))).toBe(false);
  }, 30_000);

  test.skip("active-tab end-to-end: server-side rename of an open doc fires authenticationFailed with 'rename-redirect:<newDocName>'", async () => {
    const { HocuspocusProvider } = await import('@hocuspocus/provider');
    const Y = await import('yjs');

    const fromName = `active-tab-${crypto.randomUUID()}`;
    const toName = `active-tab-${crypto.randomUUID()}`;
    await seedDoc(server, fromName);

    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${server.port}/collab`,
      name: fromName,
      document: doc,
      connect: true,
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('initial sync timed out')), 8000);
        provider.on('synced', () => {
          clearTimeout(timer);
          resolve();
        });
      });

      provider.on('close', () => {
        void provider.sendToken();
      });

      const rejectionPromise = new Promise<{ reason: string }>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('authenticationFailed did not fire within 10s')),
          10_000,
        );
        provider.on('authenticationFailed', (payload: { reason: string }) => {
          clearTimeout(timer);
          resolve(payload);
        });
      });

      expect((await renamePath(server.port, fromName, toName)).status).toBe(200);

      const failed = await rejectionPromise;
      const parsed = parseAuthRejectionWire(failed.reason);
      expect(parsed.kind).toBe('rename-redirect');
      expect(parsed.payload).toBe(toName);
    } finally {
      provider.destroy();
    }
  }, 30_000);

  test("active-tab end-to-end: server-side delete of an open doc fires authenticationFailed with 'doc-deleted'", async () => {
    const { HocuspocusProvider } = await import('@hocuspocus/provider');
    const Y = await import('yjs');

    const docName = `active-tab-del-${crypto.randomUUID()}`;
    await seedDoc(server, docName);

    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${server.port}/collab`,
      name: docName,
      document: doc,
      connect: true,
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('initial sync timed out')), 8000);
        provider.on('synced', () => {
          clearTimeout(timer);
          resolve();
        });
      });

      provider.on('close', () => {
        void provider.sendToken();
      });

      const rejectionPromise = new Promise<{ reason: string }>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('authenticationFailed did not fire within 10s')),
          10_000,
        );
        provider.on('authenticationFailed', (payload: { reason: string }) => {
          clearTimeout(timer);
          resolve(payload);
        });
      });

      expect((await deletePath(server.port, docName)).status).toBe(200);

      const failed = await rejectionPromise;
      const parsed = parseAuthRejectionWire(failed.reason);
      expect(parsed.kind).toBe('doc-deleted');
      expect(parsed.payload).toBeUndefined();
    } finally {
      provider.destroy();
    }
  }, 30_000);

  test('QA-016 (server-side dual): co-running normal rename does not pollute synthetic-doc admission', async () => {
    const fromName = `coexist-${crypto.randomUUID()}`;
    const toName = `coexist-${crypto.randomUUID()}`;
    await seedDoc(server, fromName);
    await renamePath(server.port, fromName, toName);

    expect(await runAuthGuard(server, fromName)).toBeInstanceOf(HocuspocusAuthRejection);
    expect(await runAuthGuard(server, '__system__')).toBeNull();
    expect(await runAuthGuard(server, '__config__/project')).toBeNull();
  }, 30_000);
});
