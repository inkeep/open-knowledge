import { DismissDocNoticeSuccessSchema, ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
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

function dismiss(body: unknown, method = 'POST'): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/doc-notices/dismiss`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}

describe('doc-notice-dismiss envelope (RFC 9457)', () => {
  test('dismissing a notice that does not exist is a flat success that dismissed nothing', async () => {
    const res = await dismiss({ docName: 'notes', id: 'no-such-notice' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    const parsed = DismissDocNoticeSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.dismissed).toBe(false);
    }
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('a body without an id is rejected with invalid-request', async () => {
    const res = await dismiss({ docName: 'notes' });
    expect(res.status).toBe(400);

    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
    }
  });

  test('method-not-allowed on GET emits problem+json with Allow: POST', async () => {
    const res = await dismiss(undefined, 'GET');
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');

    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:method-not-allowed');
    }
  });
});
