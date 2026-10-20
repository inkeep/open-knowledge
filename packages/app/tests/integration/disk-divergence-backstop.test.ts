import { randomUUID } from 'node:crypto';
import { getMetrics } from '@inkeep/open-knowledge-server';
import { afterEach, describe, expect, test } from 'vitest';
import {
  agentWriteMd,
  awaitDocQuiescence,
  createTestClient,
  createTestServer,
  pollUntil,
  readTestDoc,
  type TestServer,
} from './test-harness.ts';

const INJECTED_MARKER = 'native-divergence-injected';

let server: TestServer | undefined;

afterEach(async () => {
  delete process.env.OK_TEST_STORE_DIVERGENCE;
  if (server) {
    await server.cleanup();
    server = undefined;
  }
});

async function writeMd(
  port: number,
  markdown: string,
  opts: { docName: string; position: 'append' | 'prepend' | 'replace' },
) {
  return fetch(`http://127.0.0.1:${port}/api/agent-write-md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown, ...opts }),
  });
}

async function agentUndoRaw(
  port: number,
  opts: { docName: string; connectionId: string; scope?: 'last' | 'session' },
) {
  return fetch(`http://127.0.0.1:${port}/api/agent-undo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      docName: opts.docName,
      connectionId: opts.connectionId,
      scope: opts.scope ?? 'last',
    }),
  });
}

describe('store-time compare: an outside write between the pre-write merge and the store', () => {
  test('is merged with the agent write instead of refusing it, and the agent line lands once', async () => {
    server = await createTestServer({ debounce: 50, maxDebounce: 200 });
    const { port, contentDir } = server;
    const docName = `l3-content-${randomUUID()}`;

    const seed = await writeMd(port, '# V1\n\nbody-v1\n', { docName, position: 'replace' });
    expect(seed.status).toBe(200);
    await pollUntil(() => readTestDoc(contentDir, docName).includes('body-v1'));
    const mergesBefore = getMetrics().storeDiskCompare.changed ?? 0;

    process.env.OK_TEST_STORE_DIVERGENCE = docName;
    const attempt = await writeMd(port, 'AGENT-APPEND-XYZ\n', { docName, position: 'append' });
    expect(attempt.status).toBe(200);
    delete process.env.OK_TEST_STORE_DIVERGENCE;

    const merged = '# NATIVE\n\nnative-divergence-injected\n\nAGENT-APPEND-XYZ\n';
    await pollUntil(() => readTestDoc(contentDir, docName) === merged);
    expect(server.instance.hocuspocus.documents.get(docName)?.getText('source').toString()).toBe(
      merged,
    );
    expect(merged.split('AGENT-APPEND-XYZ')).toHaveLength(2);
    expect(getMetrics().storeDiskCompare.changed ?? 0).toBeGreaterThan(mergesBefore);
    expect(server.instance.conflicts.findByDocName(docName)).toBeUndefined();
  });

  test('an agent undo whose store meets an outside write merges it and the undo lands', async () => {
    server = await createTestServer({ debounce: 50, maxDebounce: 200 });
    const { port, contentDir } = server;
    const docName = `l3-undo-${randomUUID()}`;

    await agentWriteMd(port, '# Base\n\nbase-body\n', {
      docName,
      position: 'replace',
      agentId: 'u1',
    });
    await pollUntil(() => readTestDoc(contentDir, docName).includes('base-body'));
    await new Promise((r) => setTimeout(r, 700));
    await agentWriteMd(port, 'UNDO-ME-LINE\n', { docName, position: 'append', agentId: 'u1' });
    await pollUntil(() => readTestDoc(contentDir, docName).includes('UNDO-ME-LINE'));

    process.env.OK_TEST_STORE_DIVERGENCE = docName;
    const undoRes = await agentUndoRaw(port, { docName, connectionId: 'agent-u1', scope: 'last' });
    expect(undoRes.status).toBe(200);
    delete process.env.OK_TEST_STORE_DIVERGENCE;

    const merged = '# NATIVE\n\nnative-divergence-injected\n';
    await pollUntil(() => readTestDoc(contentDir, docName) === merged);
    expect(readTestDoc(contentDir, docName)).not.toContain('UNDO-ME-LINE');
    expect(server.instance.conflicts.findByDocName(docName)).toBeUndefined();
  });

  test('a person store over the same outside write keeps the person edit', async () => {
    server = await createTestServer({ debounce: 50, maxDebounce: 200 });
    const { port, contentDir } = server;
    const docName = `l3-gate-human-${randomUUID()}`;

    const seed = await writeMd(port, '# V1\n\nseed-body\n', { docName, position: 'replace' });
    expect(seed.status).toBe(200);
    await pollUntil(() => readTestDoc(contentDir, docName).includes('seed-body'));

    const client = await createTestClient(port, docName);
    try {
      await pollUntil(() => client.ytext.toString().includes('seed-body'), 5000);

      process.env.OK_TEST_STORE_DIVERGENCE = docName;

      const HUMAN_MARK = 'HUMAN-EDIT-NOT-REVERTED';
      client.doc.transact(() => {
        client.ytext.insert(client.ytext.length, `\n${HUMAN_MARK}\n`);
      });
      await awaitDocQuiescence(client.doc, { timeoutMs: 3000 });

      await pollUntil(() => readTestDoc(contentDir, docName).includes(HUMAN_MARK), 8000);
      expect(readTestDoc(contentDir, docName)).toContain(INJECTED_MARKER);
    } finally {
      delete process.env.OK_TEST_STORE_DIVERGENCE;
      await client.cleanup();
    }
  });
});
