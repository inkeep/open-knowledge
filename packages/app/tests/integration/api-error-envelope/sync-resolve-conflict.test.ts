/**
 * Per-handler narrow-integration smoke test for `handleSyncResolveConflict`.
 *
 * The test harness has a SyncEngine but no real merge in progress, so
 * `engine.resolveConflict()` for a non-existent file throws → 500. Covers
 * happy-path body validation, body-shape errors, and method gating.
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

describe('sync-resolve-conflict envelope (RFC 9457)', () => {
  test('missing file body rejected with invalid-request', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sync/resolve-conflict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategy: 'mine' }),
    });
    expect(res.status).toBe(400);

    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
    }
  });

  test('unknown strategy rejected with invalid-request', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sync/resolve-conflict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'a.md', strategy: 'magic' }),
    });
    expect(res.status).toBe(400);

    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
    }
  });

  test("strategy 'content' without content body rejected with invalid-request (not 500)", async () => {
    // Without the schema-level `.refine()`, this would reach the handler,
    // throw inside `engine.resolveConflict()` ("strategy 'content' requires
    // content parameter"), and emit `urn:ok:error:internal-server-error` 500.
    // The refinement promotes it to a typed 400 invalid-request at the
    // withValidation boundary — correct HTTP semantics for a client error.
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sync/resolve-conflict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'a.md', strategy: 'content' }),
    });
    expect(res.status).toBe(400);

    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
    }
  });

  test('method-not-allowed on GET emits problem+json with Allow: POST', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sync/resolve-conflict`);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');

    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:method-not-allowed');
    }
  });
});
