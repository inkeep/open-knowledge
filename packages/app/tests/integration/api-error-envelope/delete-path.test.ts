/**
 * Per-handler narrow-integration smoke test for `handleDeletePath`.
 *
 * Asserts the canonical RFC 9457 wire shape:
 *   - happy path: status 200, `Content-Type: application/json`, body parses
 *     against `DeletePathSuccessSchema`, no `ok: true` discriminator.
 *   - unknown kind → `urn:ok:error:invalid-request`.
 *   - target doesn’t exist → `urn:ok:error:doc-not-found`.
 *   - method-not-allowed on GET emits `urn:ok:error:method-not-allowed`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { DeletePathSuccessSchema, ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
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

async function postDelete(body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/delete-path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('delete-path envelope (RFC 9457)', () => {
  test('happy path emits flat success body with application/json', async () => {
    const id = crypto.randomUUID().slice(0, 8);
    const path = `delete-src-${id}.md`;
    const docName = `delete-src-${id}`;

    await postCreate({ path });

    const res = await postDelete({ kind: 'file', path: docName });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    const parsed = DeletePathSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.deletedDocNames).toEqual([docName]);
    }
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('unknown kind emits urn:ok:error:invalid-request', async () => {
    const res = await postDelete({ kind: 'symlink', path: 'foo' });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
    }
  });

  test('non-existent target emits urn:ok:error:doc-not-found', async () => {
    const res = await postDelete({
      kind: 'file',
      path: `missing-${crypto.randomUUID().slice(0, 8)}`,
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:doc-not-found');
    }
  });

  test('method-not-allowed on GET emits problem+json with Allow: POST', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/delete-path`, { method: 'GET' });
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
