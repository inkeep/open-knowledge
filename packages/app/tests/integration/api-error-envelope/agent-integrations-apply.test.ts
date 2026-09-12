import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentIntegrationsApplySuccessSchema,
  ProblemDetailsSchema,
} from '@inkeep/open-knowledge-core';
import { buildIngressPolicy } from '@inkeep/open-knowledge-server';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { fetchWithHostHeader } from '../host-header-request.test-helper';
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
  test('accepts loose JSON without a Content-Type gate and emits shared success headers', async () => {
    const res = await fetch(`${base()}/api/agent-integrations/apply`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:5173', 'X-Request-Id': 'apply-success-contract' },
      body: JSON.stringify({
        intents: [{ satisfierId: CLAUDE_PROJECT_MCP, desired: 'present', futureIntentField: true }],
        futureRequestField: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-request-id')).toBe('apply-success-contract');
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(res.headers.get('access-control-expose-headers')).toContain('x-request-id');
    const parsed = AgentIntegrationsApplySuccessSchema.parse(await res.json());
    expect(parsed.actions[0]?.action).toBe('skipped-unsupported');
  });

  test('reports every step unwritable rather than failing the request', async () => {
    const res = await apply({ intents: [{ satisfierId: CLAUDE_PROJECT_MCP, desired: 'present' }] });
    expect(res.status).toBe(200);

    const parsed = AgentIntegrationsApplySuccessSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const step = parsed.data.actions.find((a) => a.satisfierId === CLAUDE_PROJECT_MCP);
    expect(step?.action).toBe('skipped-unsupported');
    expect(step?.errorId).toBe('no-writer');
    expect(existsSync(join(server.contentDir, '.mcp.json'))).toBe(false);
  });

  test('answers an empty batch with a snapshot instead of an error', async () => {
    const res = await apply({ intents: [] });
    expect(res.status).toBe(200);

    const parsed = AgentIntegrationsApplySuccessSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.actions).toEqual([]);
    expect(parsed.data.conflicts).toEqual([]);
    expect(parsed.data.withheld).toEqual([]);
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

  test('reports contradictory intents as a conflict without executing an action', async () => {
    const res = await apply({
      intents: [
        { satisfierId: CLAUDE_PROJECT_MCP, desired: 'present' },
        { satisfierId: CLAUDE_PROJECT_MCP, desired: 'absent' },
      ],
    });
    expect(res.status).toBe(200);

    const parsed = AgentIntegrationsApplySuccessSchema.parse(await res.json());
    expect(parsed.actions).toEqual([]);
    expect(parsed.conflicts.map((conflict) => conflict.kind)).toContain('contradictory-intents');
  });

  test('matches the exact path with a query but not a slash or neighboring path', async () => {
    const query = await fetch(`${base()}/api/agent-integrations/apply?source=test`, {
      method: 'POST',
      body: JSON.stringify({ intents: [] }),
    });
    expect(query.status).toBe(200);
    expect(AgentIntegrationsApplySuccessSchema.safeParse(await query.json()).success).toBe(true);

    for (const suffix of ['/', '-other']) {
      const res = await fetch(`${base()}/api/agent-integrations/apply${suffix}`, {
        method: 'POST',
        body: JSON.stringify({ intents: [] }),
      });
      expect(res.status, suffix).toBe(404);
      const problem = ProblemDetailsSchema.parse(await res.json());
      expect(problem.type).toBe('urn:ok:error:not-found');
    }
  });
});

describe('agent-integrations apply — refusals use the shared envelope', () => {
  test('rejects an unsupported method before parsing malformed JSON', async () => {
    const res = await fetch(`${base()}/api/agent-integrations/apply`, {
      method: 'PATCH',
      headers: { 'X-Request-Id': 'apply-method-contract' },
      body: '{',
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-request-id')).toBe('apply-method-contract');
    const body = ProblemDetailsSchema.parse(await res.json());
    expect(body.type).toBe('urn:ok:error:method-not-allowed');
  });

  test('preserves HEAD body suppression and admitted preflight handling', async () => {
    const head = await fetch(`${base()}/api/agent-integrations/apply`, { method: 'HEAD' });
    expect(head.status).toBe(405);
    expect(head.headers.get('allow')).toBe('POST');
    expect(await head.text()).toBe('');

    const options = await fetch(`${base()}/api/agent-integrations/apply`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173', 'X-Request-Id': 'apply-preflight' },
      body: '{',
    });
    expect(options.status).toBe(204);
    expect(options.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(options.headers.get('access-control-allow-methods')).toContain('POST');
    expect(options.headers.get('x-request-id')).toBe('apply-preflight');
    expect(await options.text()).toBe('');
  });

  test('a body with no intents list is refused with problem+json', async () => {
    const res = await apply({});
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const body = ProblemDetailsSchema.parse(await res.json());
    expect(body.type).toMatch(/^urn:ok:error:/);
    expect(body.title).toBe('Request body is invalid.');
    expect(body.status).toBe(400);
  });

  test.each([
    ['an absent body', undefined, 'Request body is invalid.'],
    ['malformed JSON', '{', 'Request body is not valid JSON.'],
  ])('rejects %s with its validation title', async (_label, body, title) => {
    const res = await fetch(`${base()}/api/agent-integrations/apply`, {
      method: 'POST',
      ...(body === undefined ? {} : { body }),
    });
    expect(res.status).toBe(400);
    const problem = ProblemDetailsSchema.parse(await res.json());
    expect(problem.type).toBe('urn:ok:error:invalid-request');
    expect(problem.title).toBe(title);
  });

  test('an intent that names no artifact is refused with problem+json', async () => {
    const res = await apply({ intents: [{ desired: 'present' }] });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
  });

  test.each([
    ['an empty satisfier ID', { intents: [{ satisfierId: '', desired: 'present' }] }],
    [
      'an unsupported desired state',
      { intents: [{ satisfierId: CLAUDE_PROJECT_MCP, desired: 'later' }] },
    ],
    [
      'a non-string summary',
      { intents: [{ satisfierId: CLAUDE_PROJECT_MCP, desired: 'present' }], summary: 42 },
    ],
  ])('rejects %s at schema validation', async (_label, body) => {
    const res = await apply(body);
    expect(res.status).toBe(400);
    const problem = ProblemDetailsSchema.parse(await res.json());
    expect(problem.type).toBe('urn:ok:error:invalid-request');
    expect(problem.title).toBe('Request body is invalid.');
  });

  test('rejects a body larger than one mebibyte', async () => {
    const res = await fetch(`${base()}/api/agent-integrations/apply`, {
      method: 'POST',
      body: JSON.stringify({ intents: [], extra: 'x'.repeat(1_048_576) }),
    });
    expect(res.status).toBe(413);
    const problem = ProblemDetailsSchema.parse(await res.json());
    expect(problem).toMatchObject({
      type: 'urn:ok:error:payload-too-large',
      title: 'Payload too large.',
      status: 413,
    });
  });

  test.each([
    [
      'a rebound Host',
      'attacker.example',
      {},
      'urn:ok:error:host-not-allowed',
      'Host header not allowed.',
    ],
    [
      'a cross-origin caller',
      `127.0.0.1`,
      { Origin: 'http://attacker.example' },
      'urn:ok:error:invalid-origin',
      'Origin not allowed.',
    ],
    [
      'a forwarding header',
      `127.0.0.1`,
      { 'X-Forwarded-For': '203.0.113.8' },
      'urn:ok:error:host-not-allowed',
      'Proxied request refused: this server has not consented to external exposure. Set OK_EXTERNAL_URL to the public origin and OK_ALLOW_EXTERNAL=1 (or server.externalUrl + server.allowExternal in config), then restart the server.',
    ],
  ])('refuses %s before malformed-body parsing', async (_label, host, headers, type, title) => {
    const res = await fetchWithHostHeader(`${base()}/api/agent-integrations/apply`, host, {
      method: 'POST',
      headers,
      body: '{',
    });
    expect(res.status).toBe(403);
    const body = ProblemDetailsSchema.parse(await res.json());
    expect(body.type).toBe(type);
    expect(body.title).toBe(title);
    expect(existsSync(join(server.contentDir, '.mcp.json'))).toBe(false);
  });

  test('refuses forwarded preflight at the outer listener', async () => {
    const res = await fetchWithHostHeader(`${base()}/api/agent-integrations/apply`, '127.0.0.1', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'X-Forwarded-For': '203.0.113.8',
      },
    });
    expect(res.status).toBe(403);
    const body = ProblemDetailsSchema.parse(await res.json());
    expect(body.type).toBe('urn:ok:error:host-not-allowed');
  });

  test('admits a consented external origin and forwarding metadata before parsing', async () => {
    const external = await createTestServer({
      ingressPolicy: buildIngressPolicy({
        serverRuntime: {
          bind: ['127.0.0.1'],
          port: 0,
          externalUrl: 'https://integrations.example.com',
          allowExternal: true,
          openBrowser: false,
          idleShutdown: 'off',
          loopbackOnly: false,
        },
      }),
    });
    try {
      const res = await fetchWithHostHeader(
        `http://127.0.0.1:${external.port}/api/agent-integrations/apply`,
        '127.0.0.1',
        {
          method: 'POST',
          headers: {
            Origin: 'https://integrations.example.com',
            'X-Forwarded-For': '203.0.113.8',
          },
          body: '{',
        },
      );
      expect(res.status).toBe(400);
      const body = ProblemDetailsSchema.parse(await res.json());
      expect(body).toMatchObject({
        type: 'urn:ok:error:invalid-request',
        title: 'Request body is not valid JSON.',
      });
    } finally {
      await external.cleanup();
    }
  });
});

describe('agent-integrations apply — ephemeral admission', () => {
  test('retains apply without adding a single-file-mode prohibition', async () => {
    const contentDir = mkdtempSync(join(tmpdir(), 'ok-apply-ephemeral-'));
    writeFileSync(join(contentDir, 'note.md'), '# Note\n', 'utf8');
    let ephemeral: TestServer | undefined;
    try {
      ephemeral = await createTestServer({
        contentDir,
        ephemeral: true,
        keepContentDir: true,
        singleDocRelPath: 'note.md',
      });
      const res = await fetch(`http://127.0.0.1:${ephemeral.port}/api/agent-integrations/apply`, {
        method: 'POST',
        body: JSON.stringify({ intents: [] }),
      });
      expect(res.status).toBe(200);
      const parsed = AgentIntegrationsApplySuccessSchema.parse(await res.json());
      expect(parsed.actions).toEqual([]);
      expect(parsed.snapshot.probes.env).toBe('local-web');
    } finally {
      await ephemeral?.cleanup();
      rmSync(contentDir, { recursive: true, force: true });
    }
  });
});
