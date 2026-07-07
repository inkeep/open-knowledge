/**
 * Per-handler narrow-integration smoke test for `handleTestRescanFiles` —
 * file-index counterpart of `handleTestRescanBacklinks`. Dev-only route
 * gated on `enableTestRoutes`.
 *
 * Asserts the canonical RFC 9457 wire shape for `POST /api/test-rescan-files`:
 *   - happy path: status 200, `Content-Type: application/json`, flat body
 *     `{}` (no `ok: true` discriminator).
 *   - method-not-allowed on GET → 405 `urn:ok:error:method-not-allowed`
 *     with `Allow: POST`.
 *
 * The 503 `urn:ok:error:file-rescan-not-configured` path is unreachable in
 * `createTestServer` (the harness wires up a real watcher with
 * `rescanFromDisk`); covered by
 * `packages/server/src/api-test-rescan-files.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ProblemDetailsSchema, TestRescanFilesSuccessSchema } from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('test-rescan-files envelope (RFC 9457)', () => {
  test('happy path emits flat success body with application/json', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/test-rescan-files`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    expect(TestRescanFilesSuccessSchema.safeParse(body).success).toBe(true);
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('method-not-allowed on GET emits problem+json with Allow: POST', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/test-rescan-files`);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');

    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:method-not-allowed');
    }
  });
});
