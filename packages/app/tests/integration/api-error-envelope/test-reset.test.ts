/**
 * Per-handler narrow-integration smoke test for `handleTestReset`
 * This is a dev-only route gated on
 * `enableTestRoutes` (defaulted ON in `createTestServer`).
 *
 * Asserts the canonical RFC 9457 wire shape for `POST /api/test-reset?docName=...`:
 *   - happy path: status 200, `Content-Type: application/json`, flat body
 *     `{}` (no `ok: true` discriminator).
 *   - path-traversal docName → 400 `urn:ok:error:invalid-request`.
 *   - method-not-allowed on GET → 405 `urn:ok:error:method-not-allowed`
 *     with `Allow: POST`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ProblemDetailsSchema, TestResetSuccessSchema } from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('test-reset envelope (RFC 9457)', () => {
  test('happy path emits flat success body with application/json', async () => {
    const docName = `test-reset-target-${crypto.randomUUID().slice(0, 8)}`;
    const res = await fetch(`http://127.0.0.1:${server.port}/api/test-reset?docName=${docName}`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    expect(TestResetSuccessSchema.safeParse(body).success).toBe(true);
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('path-traversal docName emits 400 urn:ok:error:invalid-request', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/test-reset?docName=${encodeURIComponent('../escape')}`,
      { method: 'POST' },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
    }
  });

  test('method-not-allowed on GET emits problem+json with Allow: POST', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/test-reset`);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');

    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:method-not-allowed');
    }
  });
});
