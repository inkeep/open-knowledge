/**
 * Per-handler narrow-integration smoke test for `handleMetricsParseHealth`.
 *
 * Asserts the canonical RFC 9457 wire shape for
 * `GET /api/metrics/parse-health`:
 *   - happy path: status 200, `Content-Type: application/json`, body parses
 *     against `MetricsParseHealthSuccessSchema` (permissive — operators
 *     read fields by name; pinning every counter would force lockstep
 *     maintenance with `parse-health.ts`). No `ok: true` discriminator.
 *   - method-not-allowed on POST → 405 `urn:ok:error:method-not-allowed`
 *     with `Allow: GET`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MetricsParseHealthSuccessSchema, ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('metrics-parse-health envelope (RFC 9457)', () => {
  test('happy path emits flat success body with application/json', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/metrics/parse-health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    expect(MetricsParseHealthSuccessSchema.safeParse(body).success).toBe(true);
    expect((body as Record<string, unknown>).ok).toBeUndefined();
    // Top-level `parseFallback` shape is the operator-visible field name.
    const parseFallback = (body as Record<string, unknown>).parseFallback;
    expect(parseFallback && typeof parseFallback === 'object').toBe(true);
  });

  test('method-not-allowed on POST emits problem+json with Allow: GET', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/metrics/parse-health`, {
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
