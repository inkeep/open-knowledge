
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { AgentUndoSuccessSchema, ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
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

async function postUndo(body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/agent-undo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('agent-undo envelope (RFC 9457)', () => {
  test('happy path emits flat success body with application/json', async () => {
    const docName = `agent-undo-success-${crypto.randomUUID().slice(0, 8)}`;
    const agentIdSuffix = `undo-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
    await agentWriteMd(server.port, '# initial\n', {
      docName,
      position: 'replace',
      agentId: agentIdSuffix,
    });

    const res = await postUndo({ docName, connectionId: `agent-${agentIdSuffix}`, scope: 'last' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    const parsed = AgentUndoSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.docName).toBe(docName);
      expect(parsed.data.scope).toBe('last');
      expect(typeof parsed.data.undone).toBe('boolean');
    }
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('no active session emits 404 urn:ok:error:no-active-session', async () => {
    const docName = `agent-undo-no-session-${crypto.randomUUID().slice(0, 8)}`;
    const res = await postUndo({ docName, connectionId: 'agent-nonexistent', scope: 'last' });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:no-active-session');
      expect(parsed.data.status).toBe(404);
      expect(parsed.data.instance).toBeDefined();
      if (parsed.data.instance) expect(parsed.data.instance).toMatch(UUID_RE);
    }
  });

  test('missing connectionId emits urn:ok:error:invalid-request (pre-identity)', async () => {
    const res = await postUndo({ scope: 'last' });
    expect(res.status).toBe(400);
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
    }
  });

  test('reserved docname emits urn:ok:error:reserved-doc-name', async () => {
    const res = await postUndo({
      docName: '__system__',
      connectionId: 'agent-anyone',
      scope: 'last',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:reserved-doc-name');
    }
  });

  test('unknown scope enum value fails schema', async () => {
    const res = await postUndo({ connectionId: 'agent-x', scope: 'all' });
    expect(res.status).toBe(400);
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
    }
  });

  test('method-not-allowed on GET emits problem+json with Allow: POST', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-undo`, { method: 'GET' });
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
