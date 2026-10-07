import { DocumentListSuccessSchema, ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('document-list envelope (RFC 9457)', () => {
  test('happy path emits flat success body with application/json', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    const parsed = DocumentListSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Array.isArray(parsed.data.documents)).toBe(true);
    }
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('every listing shape is no-store, so a browser never writes it to its disk cache', async () => {
    const base = `http://127.0.0.1:${server.port}/api/documents`;
    const listing = await fetch(base);
    expect(listing.status).toBe(200);
    expect(listing.headers.get('cache-control')).toBe('no-store');
    await listing.body?.cancel();

    const showAll = await fetch(`${base}?showAll=true&dir=&depth=1`);
    expect(showAll.status).toBe(200);
    expect(showAll.headers.get('cache-control')).toBe('no-store');
    await showAll.body?.cancel();

    const streamed = await fetch(`${base}?showAll=true&dir=&depth=1`, {
      headers: { Accept: 'application/x-ndjson' },
    });
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get('content-type')).toBe('application/x-ndjson');
    expect(streamed.headers.get('cache-control')).toBe('no-store');
    await streamed.body?.cancel();

    const pages = await fetch(`http://127.0.0.1:${server.port}/api/pages`);
    expect(pages.status).toBe(200);
    expect(pages.headers.get('cache-control')).toBe('no-store');
    await pages.body?.cancel();
  });

  test('directory traversal attempt emits urn:ok:error:invalid-request', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/documents?dir=${encodeURIComponent('../etc')}`,
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

  test('method-not-allowed on POST emits problem+json with Allow: GET', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`, { method: 'POST' });
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
