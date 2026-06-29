
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

describe('sync-conflict-content envelope (RFC 9457)', () => {
  test('untracked file returns 404 no-conflict-tracked', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sync/conflict-content?file=a.md`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:no-conflict-tracked');
      expect((parsed.data as { file?: unknown }).file).toBe('a.md');
    }
  });

  test('missing file param emits invalid-request', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sync/conflict-content`);
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
    }
  });

  test('path traversal emits invalid-request', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/sync/conflict-content?file=../escape.md`,
    );
    expect(res.status).toBe(400);

    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
    }
  });

  test('method-not-allowed on POST emits problem+json with Allow: GET', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sync/conflict-content`, {
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
