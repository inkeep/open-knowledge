/**
 * Per-handler narrow-integration smoke test for `handleInstalledAgentsRoute`
 * `handleInstalledAgentsRoute`.
 *
 * The route gates with `checkLocalOpSecurity` (loopback + DNS-rebinding) and
 * forwards to `handleInstalledAgents` (the underlying probe + 405-on-non-GET
 * surface in `handoff-api.ts`).
 *
 * Asserts the canonical RFC 9457 wire shape for `GET /api/installed-agents`:
 *   - happy path: status 200, `Content-Type: application/json`, body is a
 *     flat boolean record (`{claude, codex, cursor}`) — no `ok: true`
 *     discriminator. (Pre-existing wire shape; preserved.)
 *   - method-not-allowed on POST → 405 `urn:ok:error:method-not-allowed`
 *     with `Allow: GET`.
 *   - cross-origin (DNS-rebinding) request → 403 problem+json from the
 *     `/api/*` Origin gate (`urn:ok:error:invalid-origin`).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { InstalledAgentsSuccessSchema, ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('installed-agents envelope (RFC 9457)', () => {
  test('happy path emits flat boolean record with application/json', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/installed-agents`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    expect(InstalledAgentsSuccessSchema.safeParse(body).success).toBe(true);
    expect((body as Record<string, unknown>).ok).toBeUndefined();
    // Each known scheme is a boolean.
    for (const scheme of ['claude', 'codex', 'cursor']) {
      expect(typeof (body as Record<string, unknown>)[scheme]).toBe('boolean');
    }
  });

  test('method-not-allowed on POST emits problem+json with Allow: GET', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/installed-agents`, {
      method: 'POST',
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:method-not-allowed');
    }
  });

  test('cross-origin Origin emits 403 urn:ok:error:invalid-origin', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/installed-agents`, {
      headers: { Origin: 'https://evil.example.com' },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-origin');
    }
  });
});
