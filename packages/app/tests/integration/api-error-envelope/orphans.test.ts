/**
 * Per-handler narrow-integration smoke test for `handleOrphans`.
 *
 * Asserts the canonical RFC 9457 wire shape for `GET /api/orphans[?mode=...]`:
 *   - happy path: status 200, `Content-Type: application/json`, body parses
 *     against `OrphansSuccessSchema`, no `ok` discriminator.
 *   - invalid orphan mode → `urn:ok:error:invalid-request`.
 *   - method-not-allowed on POST emits `urn:ok:error:method-not-allowed` +
 *     `Allow: GET` header.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { OrphansSuccessSchema, ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('orphans envelope (RFC 9457)', () => {
  test('happy path emits flat success body with application/json', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/orphans`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    const parsed = OrphansSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Array.isArray(parsed.data.orphans)).toBe(true);
    }
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('mode=incoming returns the same flat shape', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/orphans?mode=incoming`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(OrphansSuccessSchema.safeParse(body).success).toBe(true);
  });

  test('invalid orphan mode emits urn:ok:error:invalid-request', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/orphans?mode=sideways`);
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
      expect(parsed.data.title).toContain('orphan mode');
      expect(parsed.data.instance).toBeDefined();
    }
  });

  test('method-not-allowed on POST emits problem+json with Allow: GET', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/orphans`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:method-not-allowed');
    }
  });
});
