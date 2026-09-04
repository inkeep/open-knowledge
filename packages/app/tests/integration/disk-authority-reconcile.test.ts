import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  agentPatch,
  agentWriteMd,
  createTestClients,
  createTestServer,
  pollUntil,
  readTestDoc,
  type TestClient,
  type TestServer,
} from './test-harness.ts';

let server: TestServer | undefined;

afterEach(async () => {
  if (server) {
    await server.cleanup();
    server = undefined;
  }
});

async function frontmatterPatch(port: number, docName: string, patch: Record<string, unknown>) {
  return fetch(`http://127.0.0.1:${port}/api/frontmatter-patch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docName, patch }),
  });
}

async function renamePath(port: number, fromPath: string, toPath: string) {
  return fetch(`http://127.0.0.1:${port}/api/rename-path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'file', fromPath, toPath }),
  });
}

describe('PRD-6832 β L1: agent write reconciles a newer out-of-band disk edit', () => {
  test('write_document append: the native edit is NOT clobbered + FR3 warning fires', async () => {
    server = await createTestServer({ debounce: 50, maxDebounce: 200 });
    const { port, contentDir } = server;
    const docName = `reconcile-append-${randomUUID()}`;
    const filePath = join(contentDir, `${docName}.md`);

    await agentWriteMd(port, '# V1 from agent\n\nbody-v1\n', { docName, position: 'replace' });
    await pollUntil(() => readTestDoc(contentDir, docName).includes('body-v1'));

    writeFileSync(filePath, '# V2 NATIVE OUT-OF-BAND EDIT\n\nbody-v2-native\n', 'utf-8');

    const res = await fetch(`http://127.0.0.1:${port}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName,
        markdown: 'appended-by-agent-still-on-v1\n',
        position: 'append',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      warning?: { kind?: string };
      warnings?: Array<{ kind?: string }>;
    };
    expect(body.warning?.kind).toBe('disk-edit-reconciled');
    expect(body.warnings?.map((w) => w.kind)).toEqual(['disk-edit-reconciled']);

    const after = readTestDoc(contentDir, docName);
    expect(after).toContain('body-v2-native');
    expect(after).toContain('appended-by-agent-still-on-v1');
  });

  test('edit_document find/replace: runs against the live (disk-reflecting) content', async () => {
    server = await createTestServer({ debounce: 50, maxDebounce: 200 });
    const { port, contentDir } = server;
    const docName = `reconcile-patch-${randomUUID()}`;
    const filePath = join(contentDir, `${docName}.md`);

    await agentWriteMd(port, '# Doc\n\nBANANA here\n', { docName, position: 'replace' });
    await pollUntil(() => readTestDoc(contentDir, docName).includes('BANANA'));

    writeFileSync(filePath, '# Doc\n\nBANANA here\n\nnative-extra-line\n', 'utf-8');

    await agentPatch(port, 'BANANA', 'CHERRY', docName);

    const after = readTestDoc(contentDir, docName);
    expect(after).toContain('CHERRY');
    expect(after).not.toContain('BANANA');
    expect(after).toContain('native-extra-line');
  });

  test('edit_frontmatter: the native body edit is preserved while the FM patch applies', async () => {
    server = await createTestServer({ debounce: 50, maxDebounce: 200 });
    const { port, contentDir } = server;
    const docName = `reconcile-fm-${randomUUID()}`;
    const filePath = join(contentDir, `${docName}.md`);

    await agentWriteMd(port, '# Doc\n\nbody-original\n', { docName, position: 'replace' });
    await pollUntil(() => readTestDoc(contentDir, docName).includes('body-original'));

    writeFileSync(filePath, '# Doc\n\nbody-original\n\nnative-body-line\n', 'utf-8');

    const res = await frontmatterPatch(port, docName, { title: 'New Title' });
    expect(res.status).toBe(200);

    const after = readTestDoc(contentDir, docName);
    expect(after).toContain('New Title');
    expect(after).toContain('native-body-line');
  });

  test('concurrent un-flushed CRDT edit survives: L1 three-way merges disk + CRDT, agent edit lands on top (agent write first)', async () => {
    server = await createTestServer({ debounce: 300_000, maxDebounce: 600_000 });
    const { port, contentDir } = server;
    const docName = `reconcile-concurrent-${randomUUID()}`;
    const filePath = join(contentDir, `${docName}.md`);

    writeFileSync(filePath, '# Doc\n\nseed-body\n', 'utf-8');

    let clients: TestClient[] = [];
    try {
      clients = await createTestClients(port, { count: 1, docName });
      const client = clients[0];
      if (!client) throw new Error('client setup failed');
      await pollUntil(() => client.ytext.toString().includes('seed-body'));

      client.doc.transact(() => {
        client.ytext.insert(client.ytext.length, '\ncrdt-unflushed-line\n');
      });
      const serverYtext = () =>
        server?.instance.hocuspocus.documents.get(docName)?.getText('source').toString() ?? '';
      await pollUntil(() => serverYtext().includes('crdt-unflushed-line'));
      expect(readTestDoc(contentDir, docName)).not.toContain('crdt-unflushed-line');

      writeFileSync(filePath, '# Doc\n\nseed-body\n\ndisk-oob-line\n', 'utf-8');

      const res = await fetch(`http://127.0.0.1:${port}/api/agent-write-md`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docName, markdown: 'agent-line\n', position: 'append' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        warning?: { kind?: string; mergeOutcome?: string };
      };
      expect(body.warning?.kind).toBe('disk-edit-reconciled');
      expect(body.warning?.mergeOutcome).toBe('merged');

      await pollUntil(() => serverYtext().includes('agent-line'));
      expect(serverYtext()).toContain('disk-oob-line');
      expect(serverYtext()).toContain('crdt-unflushed-line');

      await pollUntil(() => {
        const d = readTestDoc(contentDir, docName);
        return (
          d.includes('agent-line') &&
          d.includes('crdt-unflushed-line') &&
          d.includes('disk-oob-line')
        );
      });
    } finally {
      for (const c of clients) {
        await c.cleanup();
      }
    }
  });

  test('arrival-order independence: file-watcher merges first, agent write does not re-ingest and revert it', async () => {
    server = await createTestServer({ debounce: 300_000, maxDebounce: 600_000 });
    const { port, contentDir } = server;
    const docName = `reconcile-watcher-first-${randomUUID()}`;
    const filePath = join(contentDir, `${docName}.md`);

    writeFileSync(filePath, '# Doc\n\nseed-body\n', 'utf-8');

    let clients: TestClient[] = [];
    try {
      clients = await createTestClients(port, { count: 1, docName });
      const client = clients[0];
      if (!client) throw new Error('client setup failed');
      await pollUntil(() => client.ytext.toString().includes('seed-body'));

      client.doc.transact(() => {
        client.ytext.insert(client.ytext.length, '\ncrdt-unflushed-line\n');
      });
      const serverYtext = () =>
        server?.instance.hocuspocus.documents.get(docName)?.getText('source').toString() ?? '';
      await pollUntil(() => serverYtext().includes('crdt-unflushed-line'));

      writeFileSync(filePath, '# Doc\n\nseed-body\n\ndisk-oob-line\n', 'utf-8');
      await pollUntil(() => serverYtext().includes('disk-oob-line'), 10_000);
      expect(serverYtext()).toContain('crdt-unflushed-line');

      const res = await fetch(`http://127.0.0.1:${port}/api/agent-write-md`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docName, markdown: 'agent-line\n', position: 'append' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { warning?: { kind?: string } };
      expect(body.warning).toBeUndefined();

      await pollUntil(() => serverYtext().includes('agent-line'));
      expect(serverYtext()).toContain('disk-oob-line');
      expect(serverYtext()).toContain('crdt-unflushed-line');

      await pollUntil(() => {
        const d = readTestDoc(contentDir, docName);
        return (
          d.includes('agent-line') &&
          d.includes('crdt-unflushed-line') &&
          d.includes('disk-oob-line')
        );
      });
    } finally {
      for (const c of clients) {
        await c.cleanup();
      }
    }
  });

  test('overlapping-block conflict: agent write is refused 409 doc-in-conflict, neither side is silently dropped', async () => {
    server = await createTestServer({ debounce: 300_000, maxDebounce: 600_000 });
    const { port, contentDir } = server;
    const docName = `reconcile-conflict-${randomUUID()}`;
    const filePath = join(contentDir, `${docName}.md`);

    writeFileSync(filePath, '# Doc\n\nshared-line\n', 'utf-8');

    let clients: TestClient[] = [];
    try {
      clients = await createTestClients(port, { count: 1, docName });
      const client = clients[0];
      if (!client) throw new Error('client setup failed');
      await pollUntil(() => client.ytext.toString().includes('shared-line'));

      client.doc.transact(() => {
        const text = client.ytext.toString();
        const at = text.indexOf('shared-line') + 'shared-line'.length;
        client.ytext.insert(at, ' crdt-version');
      });
      const serverYtext = () =>
        server?.instance.hocuspocus.documents.get(docName)?.getText('source').toString() ?? '';
      await pollUntil(() => serverYtext().includes('crdt-version'));

      writeFileSync(filePath, '# Doc\n\nshared-line disk-version\n', 'utf-8');

      const res = await fetch(`http://127.0.0.1:${port}/api/agent-write-md`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docName, markdown: 'agent-line\n', position: 'append' }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { type?: string };
      expect(body.type).toBe('urn:ok:error:doc-in-conflict');

      expect(serverYtext()).toContain('crdt-version');
      expect(serverYtext()).not.toContain('agent-line');
      expect(readTestDoc(contentDir, docName)).toContain('disk-version');
    } finally {
      for (const c of clients) {
        await c.cleanup();
      }
    }
  });

  test('conflict markers on disk: L1 refuses to ingest them and the agent write is refused 409', async () => {
    server = await createTestServer({ debounce: 300_000, maxDebounce: 600_000 });
    const { port, contentDir } = server;
    const docName = `reconcile-markers-${randomUUID()}`;
    const filePath = join(contentDir, `${docName}.md`);

    writeFileSync(filePath, '# Doc\n\nseed-body\n', 'utf-8');

    let clients: TestClient[] = [];
    try {
      clients = await createTestClients(port, { count: 1, docName });
      const client = clients[0];
      if (!client) throw new Error('client setup failed');
      await pollUntil(() => client.ytext.toString().includes('seed-body'));

      client.doc.transact(() => {
        client.ytext.insert(client.ytext.length, '\ncrdt-unflushed-line\n');
      });
      const serverYtext = () =>
        server?.instance.hocuspocus.documents.get(docName)?.getText('source').toString() ?? '';
      await pollUntil(() => serverYtext().includes('crdt-unflushed-line'));

      writeFileSync(
        filePath,
        '# Doc\n\n<<<<<<< HEAD\nseed-body\n=======\nother-side\n>>>>>>> theirs\n',
        'utf-8',
      );

      const res = await fetch(`http://127.0.0.1:${port}/api/agent-write-md`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docName, markdown: 'agent-line\n', position: 'append' }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { type?: string };
      expect(body.type).toBe('urn:ok:error:doc-in-conflict');

      expect(serverYtext()).not.toContain('<<<<<<<');
      expect(serverYtext()).toContain('crdt-unflushed-line');
      expect(serverYtext()).not.toContain('agent-line');
    } finally {
      for (const c of clients) {
        await c.cleanup();
      }
    }
  });

  test('rename: the renamed doc carries the newer out-of-band disk content', async () => {
    server = await createTestServer({ debounce: 50, maxDebounce: 200 });
    const { port, contentDir } = server;
    const fromDoc = `reconcile-rename-from-${randomUUID()}`;
    const toDoc = `reconcile-rename-to-${randomUUID()}`;
    const fromPath = join(contentDir, `${fromDoc}.md`);

    await agentWriteMd(port, '# V1\n\nbody-v1\n', { docName: fromDoc, position: 'replace' });
    await pollUntil(() => readTestDoc(contentDir, fromDoc).includes('body-v1'));

    writeFileSync(fromPath, '# V2 NATIVE OUT-OF-BAND EDIT\n\nbody-v2-native\n', 'utf-8');

    const res = await renamePath(port, `${fromDoc}.md`, `${toDoc}.md`);
    expect(res.status).toBe(200);

    const after = readTestDoc(contentDir, toDoc);
    expect(after).toContain('body-v2-native');
  });
});
