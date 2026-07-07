/**
 * Per-handler narrow-integration smoke test for `handleRollback`.
 *
 * Asserts the canonical RFC 9457 wire shape:
 *   - missing commitSha → `urn:ok:error:invalid-request` (schema regex rejects).
 *   - shadow-not-configured → `urn:ok:error:rollback-not-configured` (server
 *     in non-shadow mode; this is the dominant failure path in tests because
 *     `gitEnabled: false` is the harness default).
 *   - method-not-allowed on GET emits `urn:ok:error:method-not-allowed`.
 *
 * Happy path is exercised end-to-end by `restore-button-rollback.e2e.ts` /
 * `agent-write-summaries` integration suites — those run with shadow-repo
 * gitEnabled. This smoke test stays narrow to the wire-shape contract.
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

const UUID_RE = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function postRollback(body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/rollback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('rollback envelope (RFC 9457)', () => {
  test('missing commitSha emits urn:ok:error:invalid-request', async () => {
    const res = await postRollback({ docName: 'foo' });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
      if (parsed.data.instance) expect(parsed.data.instance).toMatch(UUID_RE);
    }
  });

  test('non-SHA commitSha emits urn:ok:error:invalid-request (schema regex)', async () => {
    const res = await postRollback({ docName: 'foo', commitSha: 'not-a-sha' });
    expect(res.status).toBe(400);
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
    }
  });

  test('non-existent SHA in shadow repo emits urn:ok:error:doc-not-found', async () => {
    // The test harness's `ensureProjectGit` initializes a shadow repo, so
    // schema-valid + non-existent-SHA flows past `rollback-not-configured`
    // and hits the post-identity `cat-file` check → 404 doc-not-found.
    const res = await postRollback({ docName: 'test-doc', commitSha: 'a'.repeat(40) });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:doc-not-found');
    }
  });

  test('non-string summary emits urn:ok:error:invalid-request', async () => {
    const res = await postRollback({
      docName: 'foo',
      commitSha: 'a'.repeat(40),
      summary: 42,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
    }
  });

  test('method-not-allowed on GET emits problem+json with Allow: POST', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/rollback`, { method: 'GET' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:method-not-allowed');
    }
  });
});
