/**
 * Per-handler narrow-integration smoke test for `handleTestFlushGit` —
 * dev-only route gated on `enableTestRoutes` that drains the L2 git-commit
 * pipeline (pending debounce timer + in-flight commit) before responding.
 * Exists so integration tests can AWAIT WIP-commit durability instead of
 * racing the fire-and-forget `flushDocToGit` chain against a wall-clock
 * budget.
 *
 * Asserts the canonical RFC 9457 wire shape for `POST /api/test-flush-git`:
 *   - happy path: status 200, `Content-Type: application/json`, flat body
 *     `{}` (no `ok: true` discriminator).
 *   - method-not-allowed on GET → 405 `urn:ok:error:method-not-allowed`
 *     with `Allow: POST`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ProblemDetailsSchema, TestFlushGitSuccessSchema } from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('test-flush-git envelope (RFC 9457)', () => {
  test('happy path emits flat success body with application/json', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/test-flush-git`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    expect(TestFlushGitSuccessSchema.safeParse(body).success).toBe(true);
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('method-not-allowed on GET emits problem+json with Allow: POST', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/test-flush-git`, {
      method: 'GET',
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(res.headers.get('allow')).toBe('POST');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:method-not-allowed');
    }
  });
});
