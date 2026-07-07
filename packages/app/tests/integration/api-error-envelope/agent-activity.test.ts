/**
 * Per-handler narrow-integration smoke test for `handleAgentActivity`.
 *
 * Asserts the canonical RFC 9457 wire shape for `GET /api/agent-activity?agentId=...`:
 *   - happy path: status 200, `Content-Type: application/json`, body parses
 *     against `AgentActivitySuccessSchema`, no `ok` discriminator. Returns the
 *     zero-state ledger (sessionAlive=false, agent=null, files=[]) for an
 *     unknown agentId — the route is read-only + agent-id-bound.
 *   - missing agentId → 400 `urn:ok:error:invalid-request`.
 *   - method-not-allowed on POST → 405 `urn:ok:error:method-not-allowed`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { AgentActivitySuccessSchema, ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
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

describe('agent-activity envelope (RFC 9457)', () => {
  test('happy path emits flat success body with application/json (unknown agent → zero state)', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/agent-activity?agentId=agent-nonexistent`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    const parsed = AgentActivitySuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sessionAlive).toBe(false);
      expect(parsed.data.agent).toBeNull();
      expect(parsed.data.files).toEqual([]);
    }
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('missing agentId emits 400 urn:ok:error:invalid-request', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-activity`);
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
      expect(parsed.data.status).toBe(400);
      expect(parsed.data.instance).toBeDefined();
      if (parsed.data.instance) expect(parsed.data.instance).toMatch(UUID_RE);
    }
  });

  test('method-not-allowed on POST emits problem+json with Allow: GET', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-activity?agentId=agent-x`, {
      method: 'POST',
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:method-not-allowed');
    }
  });
});
