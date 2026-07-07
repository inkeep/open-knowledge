/**
 * Per-handler narrow-integration smoke test for `handleLocalOpAuthSetIdentity`.
 * Covers method gating, schema validation (whitespace-
 * only name/email rejection), and the happy-path empty success body.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { LocalOpAuthEmptySuccessSchema, ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

async function postSetIdentity(body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/local-op/auth/set-identity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('local-op-auth-set-identity envelope (RFC 9457, US-012)', () => {
  test('happy path writes git config and returns flat empty success body', async () => {
    const res = await postSetIdentity({
      name: `Test User ${crypto.randomUUID().slice(0, 8)}`,
      email: 'test@example.com',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    const body = await res.json();
    const parsed = LocalOpAuthEmptySuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('whitespace-only name fails schema with urn:ok:error:invalid-request', async () => {
    const res = await postSetIdentity({ name: '   ', email: 'test@example.com' });
    expect(res.status).toBe(400);
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
      expect(parsed.data.detail ?? '').toMatch(/name/i);
    }
  });

  test('whitespace-only email fails schema with urn:ok:error:invalid-request', async () => {
    const res = await postSetIdentity({ name: 'Alice', email: '   ' });
    expect(res.status).toBe(400);
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
      expect(parsed.data.detail ?? '').toMatch(/email/i);
    }
  });

  test('missing fields fails schema with urn:ok:error:invalid-request', async () => {
    const res = await postSetIdentity({ name: 'Alice' });
    expect(res.status).toBe(400);
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
    }
  });

  test('malformed JSON body emits problem+json 400', async () => {
    const res = await postSetIdentity('not-valid-json{');
    expect(res.status).toBe(400);
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
    }
  });

  test('method-not-allowed on GET emits problem+json with Allow: POST', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/local-op/auth/set-identity`, {
      method: 'GET',
    });
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
