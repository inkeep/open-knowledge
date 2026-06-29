
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { LinkGraphSuccessSchema, ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('link-graph envelope (RFC 9457)', () => {
  test('happy path emits flat success body with application/json', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/link-graph`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    const parsed = LinkGraphSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Array.isArray(parsed.data.nodes)).toBe(true);
      expect(Array.isArray(parsed.data.links)).toBe(true);
    }
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('scoped neighborhood query (docName + degrees) succeeds', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/link-graph?docName=any-doc&degrees=1`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    const parsed = LinkGraphSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
  });

  test('unsafe docName emits urn:ok:error:invalid-request', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/link-graph?docName=${encodeURIComponent('../etc')}`,
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
    }
  });

  test('degrees without docName emits urn:ok:error:invalid-request', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/link-graph?degrees=1`);
    expect(res.status).toBe(400);

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
      expect(parsed.data.title).toContain('docName is required');
    }
  });

  test('negative degrees emits urn:ok:error:invalid-request', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/link-graph?docName=any-doc&degrees=-1`,
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
      expect(parsed.data.title).toContain('non-negative');
    }
  });

  test('method-not-allowed on POST emits problem+json with Allow: GET', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/link-graph`, { method: 'POST' });
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
