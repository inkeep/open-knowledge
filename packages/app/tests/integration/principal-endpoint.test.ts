
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
