/**
 * Per-handler narrow-integration smoke test for `handleMetricsReconciliation`
 *
 *
 * Asserts the canonical RFC 9457 wire shape for
 * `GET /api/metrics/reconciliation`:
 *   - happy path: status 200, `Content-Type: application/json`, body parses
 *     against `MetricsReconciliationSuccessSchema` (permissive — operators
 *     read fields by name; pinning every counter would force lockstep
 *     maintenance with `metrics.ts`). No `ok: true` discriminator.
 *   - method-not-allowed on POST → 405 `urn:ok:error:method-not-allowed`
 *     with `Allow: GET`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  MetricsReconciliationSuccessSchema,
  ProblemDetailsSchema,
} from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('metrics-reconciliation envelope (RFC 9457)', () => {
  test('happy path emits flat success body with application/json', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/metrics/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    expect(MetricsReconciliationSuccessSchema.safeParse(body).success).toBe(true);
    expect((body as Record<string, unknown>).ok).toBeUndefined();
    // The known counters should be present even though the schema is permissive.
    expect(typeof (body as Record<string, unknown>).reconcileCount).toBe('number');
  });

  test('method-not-allowed on POST emits problem+json with Allow: GET', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/metrics/reconciliation`, {
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
