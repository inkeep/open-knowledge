/**
 * Per-handler narrow-integration smoke test for `handleSaveVersion`.
 *
 * Covers the canonical RFC 9457 wire shape:
 *   - happy path with empty body: status 200, `Content-Type: application/json`,
 *     body parses against `SaveVersionSuccessSchema`, no `ok: true` discriminator.
 *   - body-shape failure (writer.id violates SAFE_ID_RE): emits
 *     `urn:ok:error:invalid-request` problem+json.
 *   - method-not-allowed on GET emits `urn:ok:error:method-not-allowed`
 *     + `Allow: POST` header.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ProblemDetailsSchema, SaveVersionSuccessSchema } from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('save-version envelope (RFC 9457)', () => {
  test('happy path emits flat success body with application/json', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/save-version`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    const parsed = SaveVersionSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(typeof parsed.data.checkpointRef).toBe('string');
      expect(parsed.data.checkpointRef.length).toBeGreaterThan(0);
    }
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('writer-id violation emits problem+json invalid-request', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/save-version`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        writers: [{ id: 'has spaces and !@#$' }],
      }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
      expect(parsed.data.status).toBe(400);
      expect(typeof parsed.data.instance).toBe('string');
    }
  });

  test('method-not-allowed on GET emits problem+json with Allow: POST', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/save-version`, {
      method: 'GET',
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(res.headers.get('allow')).toBe('POST');
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:method-not-allowed');
    }
  });
});
