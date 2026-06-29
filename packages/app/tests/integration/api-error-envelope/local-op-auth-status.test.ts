import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { LocalOpAuthStatusSuccessSchema, ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({
    localOpCliArgs: ['/nonexistent-test-binary-do-not-create-this-file'],
  });
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

async function postStatus(body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/local-op/auth/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('local-op-auth-status envelope (RFC 9457, US-012)', () => {
  test('spawn failure emits urn:ok:error:auth-failed problem+json 500', async () => {
    const res = await postStatus({});
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:auth-failed');
      expect(parsed.data.status).toBe(500);
    }
  });

  test('LocalOpAuthStatusSuccessSchema accepts CLI-emitted shape', () => {
    expect(LocalOpAuthStatusSuccessSchema.safeParse({ authenticated: false }).success).toBe(true);
    expect(
      LocalOpAuthStatusSuccessSchema.safeParse({
        authenticated: true,
        login: 'alice',
        host: 'github.com',
      }).success,
    ).toBe(true);
  });

  test('malformed JSON body emits problem+json 400', async () => {
    const res = await postStatus('not-valid-json{');
    expect(res.status).toBe(400);
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
    }
  });

  test('empty host string fails schema with urn:ok:error:invalid-request', async () => {
    const res = await postStatus({ host: '' });
    expect(res.status).toBe(400);
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
    }
  });

  test('method-not-allowed on GET emits problem+json with Allow: POST', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/local-op/auth/status`, {
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
