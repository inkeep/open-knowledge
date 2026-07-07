/**
 * Per-handler narrow-integration smoke test for `handleAgentWriteMd`.
 *
 * Asserts the canonical RFC 9457 wire shape:
 *   - happy path: status 200, `Content-Type: application/json`, body parses
 *     against `AgentWriteMdSuccessSchema` (timestamp + subscriber counts +
 *     optional hints/summary), no `ok: true` discriminator.
 *   - missing markdown → `urn:ok:error:invalid-request` (pre-identity body
 *     shape rejection from `withValidation`).
 *   - reserved docname → `urn:ok:error:reserved-doc-name` (post-identity semantic).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { AgentWriteMdSuccessSchema, ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
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

async function postWriteMd(body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('agent-write-md envelope (RFC 9457)', () => {
  test('happy path emits flat success body with application/json', async () => {
    const docName = `agent-write-md-success-${crypto.randomUUID().slice(0, 8)}`;
    const res = await postWriteMd({ markdown: '# Hello\n', position: 'replace', docName });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    const parsed = AgentWriteMdSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.timestamp.length).toBeGreaterThan(0);
      expect(typeof parsed.data.subscriberCount).toBe('number');
      expect(typeof parsed.data.systemSubscriberCount).toBe('number');
    }
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('missing markdown emits urn:ok:error:invalid-request', async () => {
    const res = await postWriteMd({ position: 'replace' });
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

  test('empty markdown string is accepted by the endpoint (schema no longer rejects empty)', async () => {
    // The endpoint is permissive: empty `markdown` parses and returns 200. This
    // exercises the wire-contract relaxation (no `.min(1)`), NOT the
    // clear-existing-body behavior — `docName` is fresh, so there is no prior
    // body to clear. Body-clearing is covered in agent-sessions.test.ts; the
    // "don't create empty docs" policy lives in the MCP `write_document` tool.
    const docName = `agent-write-md-empty-${crypto.randomUUID().slice(0, 8)}`;
    const res = await postWriteMd({ markdown: '', position: 'replace', docName });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    const body = await res.json();
    const parsed = AgentWriteMdSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
  });

  test('unknown position enum value fails schema', async () => {
    const res = await postWriteMd({ markdown: '# Hi', position: 'overwrite' });
    expect(res.status).toBe(400);
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
    }
  });

  test('reserved docname emits urn:ok:error:reserved-doc-name', async () => {
    const res = await postWriteMd({
      markdown: '# Should reject',
      position: 'replace',
      docName: '__system__',
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:reserved-doc-name');
      expect(parsed.data.status).toBe(400);
    }
  });

  test('method-not-allowed on GET emits problem+json with Allow: POST', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
      method: 'GET',
    });
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
