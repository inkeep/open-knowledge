import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  agentPatch,
  agentWriteMd,
  awaitWipCommits,
  createTestServer,
  type TestServer,
} from './test-harness.ts';

let server: TestServer | undefined;

afterEach(async () => {
  delete process.env.OK_TEST_STORE_FAULT;
  if (server) {
    await server.cleanup();
    server = undefined;
  }
});

describe('disk-persistence failure surfacing — edit_document (/api/agent-patch)', () => {
  test('reports a storage error instead of a false success when the store fails', async () => {
    server = await createTestServer();
    const docName = `patch-fault-${randomUUID()}`;
    await agentWriteMd(server.port, '# Doc\n\nFINDME here\n', { docName, position: 'replace' });

    process.env.OK_TEST_STORE_FAULT = docName;
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-patch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ find: 'FINDME', replace: 'REPLACED', docName }),
    });

    expect(res.status).toBe(507); // ENOSPC → storage-full
    const body = (await res.json()) as { type?: string };
    expect(body.type).toBe('urn:ok:error:storage-full');
  });

  test('still reports success when the store reaches disk', async () => {
    server = await createTestServer();
    const docName = `patch-ok-${randomUUID()}`;
    await agentWriteMd(server.port, '# Doc\n\nFINDME here\n', { docName, position: 'replace' });

    const result = await agentPatch(server.port, 'FINDME', 'REPLACED', docName);

    expect(result.ok).toBe(true);
  });
});

async function frontmatterPatch(port: number, docName: string, patch: Record<string, unknown>) {
  return fetch(`http://127.0.0.1:${port}/api/frontmatter-patch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docName, patch }),
  });
}

describe('disk-persistence failure surfacing — edit_frontmatter (/api/frontmatter-patch)', () => {
  test('reports a storage error instead of a false success when the store fails', async () => {
    server = await createTestServer();
    const docName = `fm-fault-${randomUUID()}`;
    await agentWriteMd(server.port, '# Doc\n\nbody\n', { docName, position: 'replace' });

    process.env.OK_TEST_STORE_FAULT = docName;
    const res = await frontmatterPatch(server.port, docName, { title: 'New Title' });

    expect(res.status).toBe(507);
    const body = (await res.json()) as { type?: string };
    expect(body.type).toBe('urn:ok:error:storage-full');
  });

  test('still reports success when the store reaches disk', async () => {
    server = await createTestServer();
    const docName = `fm-ok-${randomUUID()}`;
    await agentWriteMd(server.port, '# Doc\n\nbody\n', { docName, position: 'replace' });

    const res = await frontmatterPatch(server.port, docName, { title: 'New Title' });

    expect(res.status).toBe(200);
  });
});

describe('disk-persistence failure surfacing — version rollback (/api/rollback)', () => {
  test('reports a storage error instead of a false success when the rollback store fails', async () => {
    server = await createTestServer({ gitEnabled: true, commitDebounceMs: 100 });
    const docName = `rb-fault-${randomUUID()}`;

    await agentWriteMd(server.port, '# V1\n\nbody one\n', { docName, position: 'replace' });
    await awaitWipCommits(server, docName, 1);
    await agentWriteMd(server.port, '# V2\n\nbody two\n', { docName, position: 'replace' });
    const shas = await awaitWipCommits(server, docName, 2);

    const priorSha = shas[shas.length - 1]; // oldest WIP commit = V1
    expect(priorSha).toMatch(/^[0-9a-f]{40}$/i);

    process.env.OK_TEST_STORE_FAULT = docName;
    const res = await fetch(`http://127.0.0.1:${server.port}/api/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName, commitSha: priorSha }),
    });

    expect(res.status).toBe(507);
    const body = (await res.json()) as { type?: string };
    expect(body.type).toBe('urn:ok:error:storage-full');
  });
});

