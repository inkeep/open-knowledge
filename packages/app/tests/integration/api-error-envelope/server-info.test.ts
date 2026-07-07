/**
 * Per-handler narrow-integration smoke test for `handleServerInfo`.
 *
 *   - happy path: 200, application/json, body parses against
 *     `ServerInfoSuccessSchema` (flat shape, no `ok: true` wrapper).
 *   - method-not-allowed on POST → `urn:ok:error:method-not-allowed`.
 *   - `Cache-Control: no-store` header preserved.
 *   - the optional `boot` timings block round-trips through the schema.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  ProblemDetailsSchema,
  ServerInfoBootSchema,
  ServerInfoSuccessSchema,
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

describe('server-info envelope (RFC 9457)', () => {
  test('happy path emits flat success body with application/json + no-store', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/server-info`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    const parsed = ServerInfoSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.serverInstanceId.length).toBeGreaterThan(0);
    }
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('optional boot timings block round-trips through the success schema', () => {
    // The ephemeral test harness boots via `createServer` (not `bootServer`),
    // so it never calls `startBootTimings` and the live `/api/server-info`
    // body omits `boot`. Assert the additive shape directly: a fully-populated
    // boot block (the standalone-boot case) parses, and `boot` is genuinely
    // optional on the envelope.
    const boot = {
      startedAt: '2026-06-30T00:00:00.000Z',
      httpListenMs: 12,
      seedWalkMs: 34,
      indexesMs: 56,
      readyMs: 78,
      fileCount: 9,
    };
    expect(ServerInfoBootSchema.safeParse(boot).success).toBe(true);

    const withBoot = ServerInfoSuccessSchema.safeParse({
      serverInstanceId: 'test-instance',
      currentBranch: 'main',
      boot,
    });
    expect(withBoot.success).toBe(true);
    if (withBoot.success) {
      expect(withBoot.data.boot).toEqual(boot);
    }

    // `boot` absent is still valid (dev-server / plugin path).
    const withoutBoot = ServerInfoSuccessSchema.safeParse({
      serverInstanceId: 'test-instance',
    });
    expect(withoutBoot.success).toBe(true);
    if (withoutBoot.success) {
      expect(withoutBoot.data.boot).toBeUndefined();
    }

    // Every duration/count field is optional — a boot block with only the
    // required `startedAt` still parses.
    expect(ServerInfoBootSchema.safeParse({ startedAt: '2026-06-30T00:00:00.000Z' }).success).toBe(
      true,
    );
    // Negative durations are rejected (`.nonnegative()`).
    expect(
      ServerInfoBootSchema.safeParse({ startedAt: '2026-06-30T00:00:00.000Z', readyMs: -1 })
        .success,
    ).toBe(false);
  });

  test('method-not-allowed on POST emits problem+json with Allow: GET', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/server-info`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(res.headers.get('allow')).toBe('GET');
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:method-not-allowed');
    }
  });
});
