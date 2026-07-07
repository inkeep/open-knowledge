/**
 * Integration test for the `/api/*` dispatch fallback — the catch-all that
 * emits `errorResponse(response, 404, 'urn:ok:error:not-found', ...)` for
 * unrecognized API paths.
 *
 * The fallback lives OUTSIDE all handler bodies (after the route table at
 * the bottom of `api-extension.ts`'s `onRequest` extension). The
 * `error-envelope-coverage.test.ts` AST scanner only walks per-handler
 * bodies, so a regression that drops the fallback or changes its wire
 * shape (status, URN, Content-Type) would escape that meta-test entirely.
 * Pin the contract here so SDK consumers branching on
 * `urn:ok:error:not-found` for the unmatched-route case have a stable
 * floor.
 */

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
    // The fallback fires after route dispatch, regardless of HTTP method —
    // POST/PUT/DELETE on an unrecognized path lands in the same 404 path
    // as GET. Pin the contract so a refactor that splits the fallback by
    // method (e.g., 405 for POST on non-existent paths) trips this test.
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
    // A registered prefix with an unknown suffix (e.g.,
    // `/api/sync/<unknown>`) must also fall through to the catch-all
    // rather than match a partial route. Pin so a future refactor that
    // adds path-prefix matching for "API namespace exists" doesn't
    // silently change the response shape.
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sync/no-such-subpath`);
    expect(res.status).toBe(404);
    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:not-found');
    }
  });
});
