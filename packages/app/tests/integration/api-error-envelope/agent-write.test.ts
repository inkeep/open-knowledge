/**
 * Per-handler narrow-integration smoke test for `handleAgentWrite`.
 *
 * Asserts the canonical RFC 9457 wire shape:
 *   - happy path: status 200, `Content-Type: application/json`, body parses
 *     against `AgentWriteSuccessSchema`, no `ok: true` discriminator.
 *   - body-shape errors (pre-identity, anonymous): malformed JSON, missing
 *     POST method → `urn:ok:error:invalid-request` / `method-not-allowed`.
 *   - semantic errors (post-identity, attributed): reserved doc name →
 *     `urn:ok:error:reserved-doc-name`.
 *
 * Real server + real handler + real schema. Mocks only the in-process
 * test-harness boundary.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { AgentWriteSuccessSchema, ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
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

async function postWrite(body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/agent-write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('agent-write envelope (RFC 9457)', () => {
  test('happy path emits flat success body with application/json', async () => {
    const docName = `agent-write-success-${crypto.randomUUID().slice(0, 8)}`;
    const res = await postWrite({ docName, content: 'Hello from US-006' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    const parsed = AgentWriteSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.timestamp.length).toBeGreaterThan(0);
    }
    // Wire shape: no `ok: true` discriminator on success bodies.
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('reserved docname emits urn:ok:error:reserved-doc-name', async () => {
    // `__system__` is a reserved synthetic doc; the handler short-circuits
    // before any Y.Doc mutation. Note: this rejection is post-identity
    // (semantic, attributed), not body-shape.
    const res = await postWrite({ docName: '__system__', content: 'should reject' });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:reserved-doc-name');
      expect(parsed.data.status).toBe(400);
      expect(parsed.data.title.length).toBeGreaterThan(0);
      expect(parsed.data.instance).toBeDefined();
      if (parsed.data.instance) expect(parsed.data.instance).toMatch(UUID_RE);
      expect(parsed.data.status).toBe(res.status);
    }
  });

  test('unsafe docName emits urn:ok:error:invalid-request (pre-identity, body-shape)', async () => {
    const res = await postWrite({ docName: '../etc/passwd' });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
      expect(parsed.data.status).toBe(400);
    }
  });

  test('non-string summary fails schema validation pre-identity', async () => {
    const res = await postWrite({ summary: 42 });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
    }
  });

  test('method-not-allowed on GET emits problem+json with Allow: POST', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-write`, { method: 'GET' });
    expect(res.status).toBe(405);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(res.headers.get('allow')).toBe('POST');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:method-not-allowed');
      expect(parsed.data.status).toBe(405);
    }
  });
});
