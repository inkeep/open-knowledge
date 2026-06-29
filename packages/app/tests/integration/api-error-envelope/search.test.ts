
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ProblemDetailsSchema, SearchSuccessSchema } from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('search envelope (RFC 9457)', () => {
  test('GET happy path emits flat success body with application/json', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/search?query=${encodeURIComponent('hello')}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    const parsed = SearchSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.query).toBe('hello');
      expect(Array.isArray(parsed.data.results)).toBe(true);
    }
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('POST happy path emits flat success body with application/json', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'hello' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    const parsed = SearchSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.query).toBe('hello');
    }
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('GET with overly-long query emits urn:ok:error:invalid-request', async () => {
    const longQuery = 'x'.repeat(300);
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/search?query=${encodeURIComponent(longQuery)}`,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
    }
  });

  test('method-not-allowed on PATCH emits problem+json with Allow: GET, POST', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/search`, { method: 'PATCH' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, POST');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:method-not-allowed');
    }
  });
});
