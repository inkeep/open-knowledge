
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('unmatched /api/* route fallback (RFC 9457)', () => {
  test('unrecognized GET path emits 404 urn:ok:error:not-found problem+json', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/does-not-exist`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');

    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:not-found');
      expect(parsed.data.status).toBe(404);
      expect(parsed.data.title.length).toBeGreaterThan(0);
    }
  });

  test('unrecognized POST path emits same 404 envelope (method-agnostic)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/no-such-handler`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:not-found');
    }
  });

  test('unrecognized nested path emits same 404 envelope (path-agnostic)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sync/no-such-subpath`);
    expect(res.status).toBe(404);
    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:not-found');
    }
  });
});
