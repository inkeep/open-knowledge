import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import { createTestServer, type TestServer } from './test-harness.ts';

let server: TestServer | undefined;

afterEach(async () => {
  delete process.env.OK_TEST_STORE_FAULT;
  if (server) {
    await server.cleanup();
    server = undefined;
  }
});

async function writeMd(port: number, docName: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/agent-write-md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docName, markdown: '# persisted content\n', position: 'replace' }),
  });
}

describe('disk-persistence failure surfacing (/api/agent-write-md)', () => {
  test('reports a storage error instead of a false success when the store fails', async () => {
    server = await createTestServer();
    const docName = `fault-doc-${randomUUID()}`;
    process.env.OK_TEST_STORE_FAULT = docName;

    const res = await writeMd(server.port, docName);

    expect(res.ok).toBe(false);
    expect(res.status).toBeGreaterThanOrEqual(500);
    const body = (await res.json()) as { type?: string; title?: string };
    expect(res.status).toBe(507);
    expect(body.type).toBe('urn:ok:error:storage-full');
  });

  test('still reports success when the store reaches disk', async () => {
    server = await createTestServer();
    const docName = `ok-doc-${randomUUID()}`;

    const res = await writeMd(server.port, docName);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { type?: string };
    expect(body.type).toBeUndefined();
  });
});
