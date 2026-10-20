import { DocNoticesSuccessSchema, ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
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

describe('doc-notices envelope (RFC 9457)', () => {
  test('happy path emits a flat empty notice list', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/doc-notices`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    const parsed = DocNoticesSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.notices).toEqual([]);
    }
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('method-not-allowed on POST emits problem+json with Allow: GET', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/doc-notices`, {
      method: 'POST',
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');

    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:method-not-allowed');
    }
  });
});
