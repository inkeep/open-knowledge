
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('suggest-links envelope (RFC 9457)', () => {
  test('missing docName emits urn:ok:error:invalid-request', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/suggest-links`);
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
      `http://127.0.0.1:${server.port}/api/suggest-links?docName=${encodeURIComponent('../etc')}`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
    }
  });

  test('reserved docName emits urn:ok:error:reserved-doc-name', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/suggest-links?docName=__system__`);
    expect(res.status).toBe(400);
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:reserved-doc-name');
      expect(parsed.data.title).toContain('__system__');
    }
  });

  test('non-existent docName emits urn:ok:error:doc-not-found', async () => {
    const docName = `does-not-exist-${crypto.randomUUID().slice(0, 8)}`;
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/suggest-links?docName=${encodeURIComponent(docName)}`,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:doc-not-found');
      expect(parsed.data.status).toBe(404);
    }
  });

  test('method-not-allowed on POST emits problem+json with Allow: GET', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/suggest-links`, {
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
