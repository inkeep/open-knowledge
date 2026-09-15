import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, test } from 'vitest';
import {
  createSyncWiredTestServer,
  createTestClient,
  createTestServer,
  pollUntil,
  type TestServer,
} from './test-harness';

const BASE_CONTENT = '# Doc\n\nalpha\n\nbeta\n';
const DISK_CONTENT = '# Doc\n\nalpha-disk\n\nbeta\n';
const MARKER_CONTENT =
  '# Doc\n\n<<<<<<< ours\nalpha-ours\n=======\nalpha-theirs\n>>>>>>> theirs\n\nbeta\n';

const STORE_DEBOUNCE_MS = 30_000;
const STORE_MAX_DEBOUNCE_MS = 60_000;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
}, 60_000);

interface ConflictRow {
  file: string;
  conflict?: string;
  reason?: string;
  docName?: string | null;
}

async function listConflicts(port: number): Promise<ConflictRow[]> {
  const res = await fetch(`http://127.0.0.1:${port}/api/sync/conflicts`).catch(() => null);
  if (!res?.ok) return [];
  const data = (await res.json()) as { conflicts?: ConflictRow[] };
  return data.conflicts ?? [];
}

async function conflictContent(
  port: number,
  file: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(
    `http://127.0.0.1:${port}/api/sync/conflict-content?file=${encodeURIComponent(file)}&source=ytext`,
  );
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

async function writeProbe(port: number, docName: string, markdown: string): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/api/agent-write-md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docName, markdown, position: 'replace', agentId: 'probe' }),
  });
  return res.status;
}

async function resolveConflict(
  port: number,
  file: string,
  strategy: string,
  content?: string,
): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/api/sync/resolve-conflict`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      file,
      strategy,
      ...(content === undefined ? {} : { content }),
    }),
  });
  return res.status;
}

async function assertStaysAbsent(filePath: string, windowMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < windowMs) {
    if (existsSync(filePath)) {
      throw new Error(
        `file resurrected ${Date.now() - start}ms after a delete resolution: ${filePath}\n` +
          `content: ${JSON.stringify(readFileSync(filePath, 'utf-8').slice(0, 160))}`,
      );
    }
    await wait(100);
  }
}

async function seedDoc(server: TestServer, docName: string): Promise<void> {
  writeFileSync(join(server.contentDir, `${docName}.md`), BASE_CONTENT, 'utf-8');
  await pollUntil(
    async () => {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`).catch(() => null);
      if (!res?.ok) return false;
      const data = (await res.json()) as { documents?: Array<{ docName: string }> };
      return data.documents?.some((d) => d.docName === docName) ?? false;
    },
    30_000,
    100,
    `${docName} to be indexed`,
  );
}

async function driveReconcileConflict(
  server: TestServer,
  docName: string,
): Promise<Awaited<ReturnType<typeof createTestClient>>> {
  const client = await createTestClient(server.port, docName);
  cleanups.push(() => client.cleanup());
  await pollUntil(() => client.ytext.toString().includes('alpha'), 15_000);

  const current = client.ytext.toString();
  const at = current.indexOf('alpha');
  client.doc.transact(() => {
    client.ytext.delete(at, 'alpha'.length);
    client.ytext.insert(at, 'alpha-editor');
  });
  await pollUntil(() => client.ytext.toString().includes('alpha-editor'), 5_000);
  writeFileSync(join(server.contentDir, `${docName}.md`), DISK_CONTENT, 'utf-8');
  return client;
}

async function assertReconcileConflictIsResolvable(
  server: TestServer,
  docName: string,
  expectedReason: string,
): Promise<void> {
  const file = `${docName}.md`;

  await pollUntil(
    async () => (await listConflicts(server.port)).some((c) => c.file === file),
    30_000,
    250,
    `a tracked conflict entry for ${file}`,
  );

  const entry = (await listConflicts(server.port)).find((c) => c.file === file);
  expect(entry).toBeDefined();
  expect(entry?.conflict).toBe('reconcile');
  expect(entry?.reason).toBe(expectedReason);
  expect(entry?.docName).toBe(docName);

  const content = await conflictContent(server.port, file);
  expect(content.status).toBe(200);
  expect(content.body.conflict).toBe('reconcile');
  expect(String(content.body.base ?? '').length).toBeGreaterThan(0);
  expect(String(content.body.ours ?? '').length).toBeGreaterThan(0);
  expect(String(content.body.theirs ?? '').length).toBeGreaterThan(0);

  expect(await writeProbe(server.port, docName, '# blocked\n')).toBe(409);

  expect(await resolveConflict(server.port, file, 'content', '# Doc\n\nalpha-resolved\n')).toBe(
    200,
  );

  await pollUntil(
    async () => !(await listConflicts(server.port)).some((c) => c.file === file),
    15_000,
    100,
    `the conflict entry for ${file} to clear`,
  );

  expect(await writeProbe(server.port, docName, '# after\n')).toBe(200);
}

describe('PRD-7947: a reconcile-born conflict is tracked, inspectable and resolvable', () => {
  test('shape 1 — a three-way reconcile that conflicts registers a reconcile entry', async () => {
    const server = await createTestServer({
      debounce: STORE_DEBOUNCE_MS,
      maxDebounce: STORE_MAX_DEBOUNCE_MS,
    });
    cleanups.push(() => server.cleanup());
    const docName = `reconcile-conflicts-${crypto.randomUUID()}`;
    await seedDoc(server, docName);
    await driveReconcileConflict(server, docName);
    await assertReconcileConflictIsResolvable(server, docName, 'merged-with-markers');
  }, 120_000);

  test('shape 2 — conflict markers landing on disk register a disk-markers entry', async () => {
    const server = await createTestServer({
      debounce: STORE_DEBOUNCE_MS,
      maxDebounce: STORE_MAX_DEBOUNCE_MS,
    });
    cleanups.push(() => server.cleanup());
    const docName = `reconcile-markers-${crypto.randomUUID()}`;
    await seedDoc(server, docName);

    const client = await createTestClient(server.port, docName);
    cleanups.push(() => client.cleanup());
    await pollUntil(() => client.ytext.toString().includes('alpha'), 15_000);

    writeFileSync(join(server.contentDir, `${docName}.md`), MARKER_CONTENT, 'utf-8');

    await assertReconcileConflictIsResolvable(server, docName, 'disk-markers');
  }, 120_000);

  test('shape 3 — the same reconcile conflict is tracked with sync wired to a remote', async () => {
    const docName = `reconcile-sync-${crypto.randomUUID()}`;
    const server = await createSyncWiredTestServer({
      originSeed: { [`${docName}.md`]: BASE_CONTENT },
      serverOptions: { debounce: STORE_DEBOUNCE_MS, maxDebounce: STORE_MAX_DEBOUNCE_MS },
    });
    cleanups.push(() => server.cleanup());

    await pollUntil(
      async () => {
        const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`).catch(() => null);
        if (!res?.ok) return false;
        const data = (await res.json()) as { documents?: Array<{ docName: string }> };
        return data.documents?.some((d) => d.docName === docName) ?? false;
      },
      30_000,
      100,
      `${docName} to be indexed`,
    );

    await driveReconcileConflict(server, docName);
    await assertReconcileConflictIsResolvable(server, docName, 'merged-with-markers');
  }, 180_000);
});

describe('PRD-7947: the editor-side edit survives into the conflict stages', () => {
  test('the reconcile entry carries the pre-conflict editor text as `ours`', async () => {
    const server = await createTestServer({
      debounce: STORE_DEBOUNCE_MS,
      maxDebounce: STORE_MAX_DEBOUNCE_MS,
    });
    cleanups.push(() => server.cleanup());
    const docName = `reconcile-stages-${crypto.randomUUID()}`;
    await seedDoc(server, docName);
    await driveReconcileConflict(server, docName);

    const file = `${docName}.md`;
    await pollUntil(
      async () => (await listConflicts(server.port)).some((c) => c.file === file),
      30_000,
      250,
      `a tracked conflict entry for ${file}`,
    );

    const content = await conflictContent(server.port, file);
    expect(content.status).toBe(200);
    expect(String(content.body.theirs ?? '')).toContain('alpha-disk');
    expect(String(content.body.ours ?? '')).toContain('alpha-editor');
    expect(content.body.resolutionOptions).toEqual(
      expect.arrayContaining(['mine', 'content', 'delete']),
    );
  }, 120_000);

  test('mine lands marker-free editor text added after the conflict was raised', async () => {
    const server = await createTestServer({
      debounce: STORE_DEBOUNCE_MS,
      maxDebounce: STORE_MAX_DEBOUNCE_MS,
    });
    cleanups.push(() => server.cleanup());
    const docName = `reconcile-live-ours-${crypto.randomUUID()}`;
    const file = `${docName}.md`;
    await seedDoc(server, docName);
    const client = await driveReconcileConflict(server, docName);

    await pollUntil(
      async () => (await listConflicts(server.port)).some((c) => c.file === file),
      30_000,
      250,
      `a tracked conflict entry for ${file}`,
    );

    client.ytext.insert(client.ytext.length, '\npost-conflict editor text\n');
    let preview = '';
    await pollUntil(
      async () => {
        const content = await conflictContent(server.port, file);
        preview = String(content.body.ours ?? '');
        return preview.includes('post-conflict editor text');
      },
      15_000,
      100,
      'the live editor text to reach the conflict preview',
    );

    expect(await resolveConflict(server.port, file, 'mine')).toBe(200);
    expect(readFileSync(join(server.contentDir, file), 'utf-8')).toBe(preview);
    await pollUntil(
      () => client.ytext.toString() === preview,
      15_000,
      100,
      'the client to retain previewed text',
    );
  }, 120_000);
});

describe('PRD-7947: resolving a reconcile conflict with `delete` keeps the file gone', () => {
  test('a keystroke from the still-open editor does not restore the deleted file', async () => {
    const server = await createTestServer({
      debounce: STORE_DEBOUNCE_MS,
      maxDebounce: STORE_MAX_DEBOUNCE_MS,
    });
    cleanups.push(() => server.cleanup());
    const docName = `reconcile-delete-${crypto.randomUUID()}`;
    const file = `${docName}.md`;
    const absPath = join(server.contentDir, file);

    await seedDoc(server, docName);
    const client = await createTestClient(server.port, docName);
    cleanups.push(() => client.cleanup());
    await pollUntil(() => client.ytext.toString().includes('alpha'), 15_000);

    const at = client.ytext.toString().indexOf('alpha');
    client.doc.transact(() => {
      client.ytext.delete(at, 'alpha'.length);
      client.ytext.insert(at, 'alpha-editor');
    });
    await pollUntil(() => client.ytext.toString().includes('alpha-editor'), 5_000);
    writeFileSync(absPath, DISK_CONTENT, 'utf-8');

    await pollUntil(
      async () => (await listConflicts(server.port)).some((c) => c.file === file),
      30_000,
      250,
      `a tracked conflict entry for ${file}`,
    );

    const content = await conflictContent(server.port, file);
    expect(content.status).toBe(200);
    expect(await resolveConflict(server.port, file, 'delete')).toBe(200);

    await pollUntil(
      async () => !(await listConflicts(server.port)).some((c) => c.file === file),
      15_000,
      100,
      `the conflict entry for ${file} to clear`,
    );
    expect(existsSync(absPath)).toBe(false);

    client.ytext.insert(client.ytext.length, '\npost-delete keystroke\n');
    server.instance.hocuspocus.flushPendingStores();
    await assertStaysAbsent(absPath, 5_000);
  }, 120_000);
});
