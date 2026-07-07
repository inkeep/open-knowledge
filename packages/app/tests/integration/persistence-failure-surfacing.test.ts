/**
 * A write whose disk-persistence step fails must surface the failure, not
 * report "Written successfully". Previously `onStoreDocument` threw (e.g.
 * ENOSPC / EACCES / read-only FS), Hocuspocus caught the rethrow and kept the
 * doc in memory ("stays in memory to avoid data loss"), and the HTTP handler —
 * which had already returned 200 — told the caller the write succeeded. The
 * content never reached disk and was lost on restart: silent data loss with a
 * success response.
 *
 * `OK_TEST_STORE_FAULT=<docName>` forces the atomic write to throw a synthetic
 * ENOSPC for exactly that doc (a non-name failure — over-long names are a
 * separate validation concern), exercising the real persistence → flush →
 * surfacing path through the production server boot.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
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
    // ENOSPC maps to the storage-full problem type (507).
    expect(res.status).toBe(507);
    expect(body.type).toBe('urn:ok:error:storage-full');
  });

  test('still reports success when the store reaches disk', async () => {
    server = await createTestServer();
    const docName = `ok-doc-${randomUUID()}`;

    const res = await writeMd(server.port, docName);

    expect(res.status).toBe(200);
    // Pin the success shape: a flat success body, not an RFC 9457 problem
    // document. Guards against a refactor that returns 200 via errorResponse.
    const body = (await res.json()) as { type?: string };
    expect(body.type).toBeUndefined();
  });
});
