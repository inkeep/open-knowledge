import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { HistorySuccessSchema, ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('history envelope (RFC 9457)', () => {
  test('happy path emits flat history body for an existing doc', async () => {
    await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName: 'history-doc', markdown: '# Hello\n', position: 'replace' }),
    });

    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/history?docName=history-doc&limit=10`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    const parsed = HistorySuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Array.isArray(parsed.data.entries)).toBe(true);
    }
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('missing docName query param emits problem+json invalid-request', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/history`);
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
    }
  });

  test('invalid branch name emits problem+json invalid-request', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/history?docName=test-doc&branch=..%2Fevil`,
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

  test('concurrent identical requests stay consistent through the single-flight path (no shared-state corruption)', async () => {
    await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName: 'sf-doc', markdown: '# Coalesce\n', position: 'replace' }),
    });

    const url = `http://127.0.0.1:${server.port}/api/history?docName=sf-doc&limit=10`;
    const responses = await Promise.all(Array.from({ length: 8 }, () => fetch(url)));
    expect(responses.every((r) => r.status === 200)).toBe(true);
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as Array<{
      entries: unknown[];
      hasMore?: boolean;
    }>;
    const first = JSON.stringify(bodies[0]?.entries);
    expect(bodies.every((b) => JSON.stringify(b.entries) === first)).toBe(true);
    const parsed = HistorySuccessSchema.safeParse(bodies[0]);
    expect(parsed.success).toBe(true);
  });

  test('method-not-allowed on POST emits problem+json with Allow: GET', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/history?docName=test-doc`, {
      method: 'POST',
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(res.headers.get('allow')).toBe('GET');
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:method-not-allowed');
    }
  });
});
