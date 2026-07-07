/**
 * Integration tests for `GET /api/principal`, the endpoint that serves the
 * local git-config identity used for human presence. Mirrors the test
 * structure of `workspace-endpoint.test.ts`.
 *
 * Coverage:
 *   1. Happy path: loopback caller with a valid Host header gets a body that
 *      round-trips through PrincipalSuccessSchema.safeParse — verifies the
 *      wire shape matches the schema the client uses.
 *   2. Host-header allowlist (DNS-rebinding defense): a loopback peer with a
 *      non-loopback Host header is refused with 403, same pattern as
 *      /api/workspace.
 *   3. Auth-before-method ordering: an unauthorized caller receives 403 for
 *      every verb — the method check never fires for them, so the endpoint
 *      never leaks "I exist, I expect GET" via 405.
 *
 * Non-loopback peer and the 404-when-principal-unavailable paths are not
 * covered here: simulating a non-loopback peer requires binding the test
 * server to a non-loopback interface (not portable), and the test harness
 * does not expose a way to suppress the loadPrincipal() call that always
 * produces a principal at boot.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PrincipalSuccessSchema } from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, type TestServer } from './test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('GET /api/principal', () => {
  test('returns principal body that round-trips through PrincipalSuccessSchema', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/principal`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = PrincipalSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(typeof parsed.data.id).toBe('string');
      expect(parsed.data.id.startsWith('principal-')).toBe(true);
      expect(['git-config', 'synthesized']).toContain(parsed.data.source);
    }
  });

  test('rejects DNS-rebinding Host header with 403 host-not-allowed', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/principal`, {
      headers: { Host: 'attacker.example.com' },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const body = (await res.json()) as { type: string; status: number };
    expect(body.type).toBe('urn:ok:error:host-not-allowed');
    expect(body.status).toBe(403);
  });

  test('Host-header check fires before method dispatch (no verb fingerprinting)', async () => {
    // An unauthorized caller must see 403 for every verb — if POST-with-bad-Host
    // returned 405 instead, the endpoint would leak "I exist, I expect GET" to
    // cross-origin callers. Both GET and POST from the same bad Host must produce
    // the same 403 with the same problem-type token.
    const getRes = await fetch(`http://127.0.0.1:${server.port}/api/principal`, {
      headers: { Host: 'attacker.example.com' },
    });
    const postRes = await fetch(`http://127.0.0.1:${server.port}/api/principal`, {
      method: 'POST',
      headers: { Host: 'attacker.example.com' },
    });
    expect(getRes.status).toBe(403);
    expect(postRes.status).toBe(403);
    const getBody = (await getRes.json()) as { type: string };
    const postBody = (await postRes.json()) as { type: string };
    expect(getBody.type).toBe('urn:ok:error:host-not-allowed');
    expect(postBody.type).toBe('urn:ok:error:host-not-allowed');
  });
});
