
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ProblemDetailsSchema, RenamePathSuccessSchema } from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

async function postCreate(body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/create-page`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function postRenamePath(body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/rename-path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('rename-path envelope (RFC 9457)', () => {
  test('happy path emits flat success body with application/json', async () => {
    const id = crypto.randomUUID().slice(0, 8);
    const sourcePath = `rp-src-${id}.md`;
    const fromPath = `rp-src-${id}`;
    const toPath = `rp-dst-${id}`;

    await postCreate({ path: sourcePath });

    const res = await postRenamePath({ kind: 'file', fromPath, toPath });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    const parsed = RenamePathSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.renamed.length).toBeGreaterThan(0);
    }
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('unknown kind emits urn:ok:error:invalid-request', async () => {
    const res = await postRenamePath({ kind: 'symlink', fromPath: 'a', toPath: 'b' });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
    }
  });

  test('source doesn’t exist emits urn:ok:error:doc-not-found', async () => {
    const res = await postRenamePath({
      kind: 'file',
      fromPath: `missing-${crypto.randomUUID().slice(0, 8)}`,
      toPath: 'whatever',
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:doc-not-found');
    }
  });

  test('destination already exists emits urn:ok:error:doc-already-exists', async () => {
    const id = crypto.randomUUID().slice(0, 8);
    const srcPath = `rp-conflict-src-${id}.md`;
    const dstPath = `rp-conflict-dst-${id}.md`;
    const fromPath = `rp-conflict-src-${id}`;
    const toPath = `rp-conflict-dst-${id}`;

    await postCreate({ path: srcPath });
    await postCreate({ path: dstPath });

    const res = await postRenamePath({ kind: 'file', fromPath, toPath });
    expect(res.status).toBe(409);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:doc-already-exists');
      expect(parsed.data.status).toBe(409);
    }
  });

  test('method-not-allowed on GET emits problem+json with Allow: POST', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/rename-path`, { method: 'GET' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:method-not-allowed');
    }
  });
});
