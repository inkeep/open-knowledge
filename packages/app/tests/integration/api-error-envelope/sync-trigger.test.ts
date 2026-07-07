/**
 * Per-handler narrow-integration smoke test for `handleSyncTrigger`.
 *
 * The test harness starts a SyncEngine even without a remote (it sits
 * in `dormant` state). Coverage:
 *   - happy path: POST {op:'sync'} → 202 Accepted, flat `{op}` echo body
 *     with `application/json`.
 *   - body-shape errors via withValidation-equivalent path: schema rejects
 *     unknown `op` values with `urn:ok:error:invalid-request`.
 *   - method-not-allowed on GET → 405 with `Allow: POST`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ProblemDetailsSchema, SyncTriggerSuccessSchema } from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('sync-trigger envelope (RFC 9457)', () => {
  test('happy path emits flat 202 success body with application/json', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sync/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'sync' }),
    });
    expect(res.status).toBe(202);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    const parsed = SyncTriggerSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.op).toBe('sync');
    }
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('unknown op rejected with invalid-request (stricter than legacy)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sync/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'gibberish' }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
    }
  });

  test('method-not-allowed on GET emits problem+json with Allow: POST', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sync/trigger`);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');

    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:method-not-allowed');
    }
  });
});
