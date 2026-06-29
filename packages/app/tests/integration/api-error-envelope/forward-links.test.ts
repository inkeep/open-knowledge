
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ForwardLinksSuccessSchema, ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('forward-links envelope (RFC 9457)', () => {
  test('happy path emits flat success body with application/json', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/forward-links?docName=any-doc`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    const parsed = ForwardLinksSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.docName).toBe('any-doc');
      expect(Array.isArray(parsed.data.forwardLinks)).toBe(true);
    }
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('missing docName query param emits urn:ok:error:invalid-request', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/forward-links`);
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
      expect(parsed.data.title).toContain('docName');
    }
  });

  test('unsafe docName emits urn:ok:error:invalid-request', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/forward-links?docName=${encodeURIComponent('../etc')}`,
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
    }
  });

  test('method-not-allowed on POST emits problem+json with Allow: GET', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/forward-links`, {
      method: 'POST',
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:method-not-allowed');
    }
  });
});
