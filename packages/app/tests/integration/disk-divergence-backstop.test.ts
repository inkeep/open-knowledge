import { randomUUID } from 'node:crypto';
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

describe('PRD-6832 β L3: store-time divergence backstop', () => {
  test('reverts on TOCTOU divergence (409); disk wins; retry re-applies exactly once', async () => {
    server = await createTestServer({ debounce: 50, maxDebounce: 200 });
    const { port, contentDir } = server;
    const docName = `l3-content-${randomUUID()}`;

    const seed = await writeMd(port, '# V1\n\nbody-v1\n', { docName, position: 'replace' });
    expect(seed.status).toBe(200);
    await pollUntil(() => readTestDoc(contentDir, docName).includes('body-v1'));

    process.env.OK_TEST_STORE_DIVERGENCE = docName;

    const attempt1 = await writeMd(port, 'AGENT-APPEND-XYZ\n', {
      docName,
      position: 'append',
    });
    expect(attempt1.status).toBe(409);
    const body1 = (await attempt1.json()) as { type?: string };
    expect(body1.type).toBe('urn:ok:error:disk-divergence');

    const afterRevert = readTestDoc(contentDir, docName);
    expect(afterRevert).toContain(INJECTED_MARKER);
    expect(afterRevert).not.toContain('AGENT-APPEND-XYZ');

    delete process.env.OK_TEST_STORE_DIVERGENCE;
    const attempt2 = await writeMd(port, 'AGENT-APPEND-XYZ\n', {
      docName,
      position: 'append',
    });
    expect(attempt2.status).toBe(200);

    const afterRetry = readTestDoc(contentDir, docName);
    expect(afterRetry).toContain(INJECTED_MARKER);
    expect(afterRetry).toContain('AGENT-APPEND-XYZ');
    expect(afterRetry.split('AGENT-APPEND-XYZ').length - 1).toBe(1);
  });

  test('undo: L3 reverts on TOCTOU divergence (409); native survives; undo NOT applied', async () => {
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
    expect(undoRes.status).toBe(409);
    const body = (await undoRes.json()) as { type?: string };
    expect(body.type).toBe('urn:ok:error:disk-divergence');

    const afterRevert = readTestDoc(contentDir, docName);
    expect(afterRevert).toContain(INJECTED_MARKER);
    expect(afterRevert).not.toContain('base-body');

    delete process.env.OK_TEST_STORE_DIVERGENCE;
    await agentWriteMd(port, 'RECOVERY-LINE\n', { docName, position: 'append', agentId: 'u1' });
    await pollUntil(() => readTestDoc(contentDir, docName).includes('RECOVERY-LINE'));
    const afterRecovery = readTestDoc(contentDir, docName);
    expect(afterRecovery).toContain(INJECTED_MARKER);
    expect(afterRecovery).toContain('RECOVERY-LINE');
  });

  test('gate: an unmarked human/client store is NEVER reverted by L3', async () => {
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
    } finally {
      delete process.env.OK_TEST_STORE_DIVERGENCE;
      await client.cleanup();
    }
  });
});
