import { AgentIntegrationsApplySuccessSchema } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;
const base = () => `http://127.0.0.1:${server.port}`;

const CLAUDE_PROJECT_MCP = 'claude/mcp/project/config-entry';

function apply(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base()}/api/agent-integrations/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);
afterAll(async () => {
  await server.cleanup();
});

describe('agent-integrations apply — a host with no writers injected', () => {
  test('reports every step unwritable rather than failing the request', async () => {
    const res = await apply({ intents: [{ satisfierId: CLAUDE_PROJECT_MCP, desired: 'present' }] });
    expect(res.status).toBe(200);

    const parsed = AgentIntegrationsApplySuccessSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const step = parsed.data.actions.find((a) => a.satisfierId === CLAUDE_PROJECT_MCP);
    expect(step?.action).toBe('skipped-unsupported');
    expect(step?.errorId).toBe('no-writer');
  });

  test('answers an empty batch with a snapshot instead of an error', async () => {
    const res = await apply({ intents: [] });
    expect(res.status).toBe(200);

    const parsed = AgentIntegrationsApplySuccessSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.actions).toEqual([]);
    expect(parsed.data.snapshot.probes.env).toBe('local-web');
  });

  test('names an artifact the registry does not carry as a conflict, not a crash', async () => {
    const res = await apply({ intents: [{ satisfierId: 'nope/mcp/user/x', desired: 'present' }] });
    expect(res.status).toBe(200);

    const parsed = AgentIntegrationsApplySuccessSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.actions).toEqual([]);
    expect(parsed.data.conflicts.map((c) => c.kind)).toContain('unknown-satisfier');
  });
});

describe('agent-integrations apply — refusals use the shared envelope', () => {
  test('a body with no intents list is refused with problem+json', async () => {
    const res = await apply({});
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const body = (await res.json()) as { type?: string; status?: number };
    expect(body.type).toMatch(/^urn:ok:error:/);
    expect(body.status).toBe(400);
  });

  test('an intent that names no artifact is refused with problem+json', async () => {
    const res = await apply({ intents: [{ desired: 'present' }] });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
  });

  test('a cross-origin caller is refused before the body is read', async () => {
    const res = await apply(
      { intents: [{ satisfierId: CLAUDE_PROJECT_MCP, desired: 'present' }] },
      { Origin: 'http://attacker.example' },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { type?: string };
    expect(body.type).toBe('urn:ok:error:invalid-origin');
  });
});
