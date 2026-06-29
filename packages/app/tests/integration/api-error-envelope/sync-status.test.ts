import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ProblemDetailsSchema, SyncStatusSchema } from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('sync-status envelope (RFC 9457)', () => {
  test('happy path emits flat dormant status with application/json', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sync/status`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    const parsed = SyncStatusSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.state).toBe('dormant');
    }
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('method-not-allowed on POST emits problem+json with Allow: GET', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sync/status`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:method-not-allowed');
      expect(parsed.data.status).toBe(405);
    }
  });
});
