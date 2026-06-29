
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { AgentPatchSuccessSchema, ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { agentWriteMd, createTestServer, type TestServer } from '../test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

const UUID_RE = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function postPatch(body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/agent-patch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('agent-patch envelope (RFC 9457)', () => {
  test('happy path emits flat success body with application/json', async () => {
    const docName = `agent-patch-success-${crypto.randomUUID().slice(0, 8)}`;
    await agentWriteMd(server.port, '# Hello world\n', { docName, position: 'replace' });

    const res = await postPatch({ docName, find: 'world', replace: 'there' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    const parsed = AgentPatchSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.timestamp.length).toBeGreaterThan(0);
      expect(typeof parsed.data.subscriberCount).toBe('number');
    }
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('text-not-found emits 404 urn:ok:error:target-not-found', async () => {
    const docName = `agent-patch-notfound-${crypto.randomUUID().slice(0, 8)}`;
    await agentWriteMd(server.port, '# fixed body\n', { docName, position: 'replace' });

    const res = await postPatch({ docName, find: 'nonexistent', replace: 'x' });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:target-not-found');
      expect(parsed.data.status).toBe(404);
      expect(parsed.data.instance).toBeDefined();
      if (parsed.data.instance) expect(parsed.data.instance).toMatch(UUID_RE);
    }
  });

  test('stale-target emits 409 urn:ok:error:stale-target when explicit offset misses', async () => {
    const docName = `agent-patch-stale-${crypto.randomUUID().slice(0, 8)}`;
    await agentWriteMd(server.port, '# Hello world\n', { docName, position: 'replace' });

    const res = await postPatch({ docName, find: 'world', replace: 'there', offset: 0 });
    expect(res.status).toBe(409);
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:stale-target');
      expect(parsed.data.status).toBe(409);
    }
  });

  test('missing find field emits urn:ok:error:invalid-request (pre-identity)', async () => {
    const res = await postPatch({ replace: 'x' });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
    }
  });

  test('non-integer offset fails schema validation', async () => {
    const res = await postPatch({ find: 'a', replace: 'b', offset: 1.5 });
    expect(res.status).toBe(400);
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
    }
  });

  test('reserved docname emits urn:ok:error:reserved-doc-name', async () => {
    const res = await postPatch({
      docName: '__system__',
      find: 'anything',
      replace: 'x',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:reserved-doc-name');
    }
  });

  test('method-not-allowed on GET emits problem+json with Allow: POST', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-patch`, { method: 'GET' });
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
