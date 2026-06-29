import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { HubsSuccessSchema, ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('hubs envelope (RFC 9457)', () => {
  test('happy path emits flat success body with application/json', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/hubs`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    const parsed = HubsSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Array.isArray(parsed.data.hubs)).toBe(true);
    }
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('limit parameter is honored without changing wire shape', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/hubs?limit=5`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(HubsSuccessSchema.safeParse(body).success).toBe(true);
  });

  test('negative or non-numeric limit falls back silently to default', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/hubs?limit=-3`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(HubsSuccessSchema.safeParse(body).success).toBe(true);
  });

  test('method-not-allowed on POST emits problem+json with Allow: GET', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/hubs`, { method: 'POST' });
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
