/**
 * Per-handler narrow-integration smoke test for `handleMetricsAgentPresence`.
 *
 * Asserts the canonical RFC 9457 wire shape for
 * `GET /api/metrics/agent-presence`. This handler shares the same
 * auth-before-method-dispatch ordering as `handleWorkspace` /
 * `handlePrincipal` (loopback gate → host-allowlist gate → method check) so
 * a bad Host never leaks "verb the endpoint expects" via 405.
 *
 * Coverage:
 *   - happy path: 200 + `application/json` + body parses against
 *     `MetricsAgentPresenceSuccessSchema`, no `ok` discriminator.
 *   - DNS-rebinding Host → 403 `urn:ok:error:host-not-allowed` (must
 *     emit BEFORE the method check).
 *   - method-not-allowed on POST → 405 `urn:ok:error:method-not-allowed`
 *     with `Allow: GET`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  MetricsAgentPresenceSuccessSchema,
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

describe('metrics-agent-presence envelope (RFC 9457)', () => {
  test('happy path emits flat success body with application/json', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/metrics/agent-presence`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    expect(MetricsAgentPresenceSuccessSchema.safeParse(body).success).toBe(true);
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('DNS-rebinding Host emits 403 urn:ok:error:host-not-allowed BEFORE method check', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/metrics/agent-presence`, {
      method: 'POST',
      headers: { Host: 'evil.example.com' },
    });
    // Auth-before-method-dispatch ordering: bad Host → 403, NOT 405.
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:host-not-allowed');
    }
  });

  test('method-not-allowed on POST (with valid Host) emits problem+json with Allow: GET', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/metrics/agent-presence`, {
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
