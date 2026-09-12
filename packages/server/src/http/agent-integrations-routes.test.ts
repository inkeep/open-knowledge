import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import {
  AgentIntegrationsApplySuccessSchema,
  type Principal,
  type StepExecutor,
} from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { makeCaptureRes, parseProblem } from '../composition-rig.test-helper.ts';
import { buildIngressPolicy, type IngressPolicy } from '../ingress-policy.ts';
import { checkLocalOpSecurity } from '../local-op-security.ts';
import { loggerFactory } from '../logger.ts';
import { createAgentIntegrationsRoutes } from './agent-integrations-routes.ts';
import { type ApiRouteGroup, createApiRequestPipeline } from './api-pipeline.ts';

type AgentIntegrationsRouteDeps = Parameters<typeof createAgentIntegrationsRoutes>[0];

function buildGroup(overrides: Partial<AgentIntegrationsRouteDeps> = {}) {
  return createAgentIntegrationsRoutes({
    log: loggerFactory.getLogger('test'),
    checkLocalOpSecurity: () => true,
    getPrincipal: undefined,
    homeDirOverride: undefined,
    projectDir: undefined,
    agentIntegrations: undefined,
    ...overrides,
  });
}

const APPLY_PATH = '/api/agent-integrations/apply';

const EXTERNAL_POLICY = buildIngressPolicy({
  serverRuntime: {
    bind: ['127.0.0.1'],
    port: 0,
    externalUrl: 'https://integrations.example.com',
    allowExternal: true,
    openBrowser: false,
    idleShutdown: 'off',
    loopbackOnly: false,
  },
});

const FIXTURE_PRINCIPAL = {
  id: 'principal-real',
  display_name: 'Project User',
  display_email: 'project@example.com',
  source: 'synthesized',
  created_at: '2026-09-10T00:00:00.000Z',
} satisfies Principal;

const ACTOR_CASES = [
  {
    label: 'agent identity takes precedence over the server principal',
    body: { agentId: 'codex-actor', principalId: 'principal-spoof' },
    getPrincipal: () => FIXTURE_PRINCIPAL,
    expectedActor: 'agent',
    forbiddenExecutorValues: ['codex-actor', 'principal-real', 'principal-spoof'],
  },
  {
    label: 'the server principal supplies identity when agent identity is absent',
    body: { principalId: 'principal-spoof' },
    getPrincipal: () => FIXTURE_PRINCIPAL,
    expectedActor: 'principal',
    forbiddenExecutorValues: ['principal-real', 'principal-spoof'],
  },
  {
    label: 'body principal identity is ignored when the server has no principal',
    body: { principalId: 'principal-spoof' },
    getPrincipal: undefined,
    expectedActor: 'anonymous',
    forbiddenExecutorValues: ['principal-spoof'],
  },
] satisfies readonly {
  readonly label: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly getPrincipal: AgentIntegrationsRouteDeps['getPrincipal'];
  readonly expectedActor: 'agent' | 'principal' | 'anonymous';
  readonly forbiddenExecutorValues: readonly string[];
}[];

afterEach(() => {
  vi.restoreAllMocks();
});

type RequestOptions = {
  readonly method?: string;
  readonly host?: string;
  readonly remoteAddress?: string;
  readonly headers?: Readonly<Record<string, string>>;
};

function makeRequestBytes(body: string, options: RequestOptions = {}): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.push(Buffer.from(body));
  req.push(null);
  req.method = options.method ?? 'POST';
  req.url = '/api/agent-integrations/apply';
  req.headers = {
    host: options.host ?? '127.0.0.1',
    'content-type': 'application/json',
    ...options.headers,
  };
  Object.defineProperty(req.socket, 'remoteAddress', {
    value: options.remoteAddress ?? '127.0.0.1',
  });
  return req;
}

function makeRequest(body: unknown, options: RequestOptions = {}): IncomingMessage {
  return makeRequestBytes(JSON.stringify(body), options);
}

async function dispatchThroughPipeline(
  group: ApiRouteGroup,
  request: IncomingMessage,
  policy: IngressPolicy,
  log = loggerFactory.getLogger('agent-integrations-pipeline-test'),
) {
  const pipeline = createApiRequestPipeline({ log, policy, table: group.table });
  const { res, captured } = makeCaptureRes();
  const handled = await pipeline(request, res);
  return { captured, handled };
}

describe('createAgentIntegrationsRoutes table', () => {
  test('owns only the exact apply path and classifies it as mutating', () => {
    const group = buildGroup();
    expect(group.paths).toEqual(['/api/agent-integrations/apply']);
    expect(group.table.resolve('/api/agent-integrations/apply')?.dispatch).toBeDefined();
    expect(group.table.isMutating('/api/agent-integrations/apply')).toBe(true);
    for (const path of ['/api/agent-integrations/apply/', '/api/agent-integrations/other']) {
      expect(group.table.resolve(path), path).toBeNull();
      expect(group.table.isMutating(path), path).toBe(false);
    }
  });

  test('uses the remote socket tier and leaves user-scope probes unprobed', async () => {
    const probedScopes: string[] = [];
    const group = buildGroup({
      checkLocalOpSecurity: (req, res, opts) =>
        checkLocalOpSecurity(req, res, { ...opts, policy: EXTERNAL_POLICY }),
      agentIntegrations: {
        probe: (item) => {
          probedScopes.push(item.scope);
          return { state: 'absent' };
        },
      },
    });
    const request = makeRequest(
      { intents: [] },
      { remoteAddress: '203.0.113.8', host: 'integrations.example.com' },
    );

    expect(group.paths.filter((path) => path === APPLY_PATH)).toHaveLength(1);
    expect(group.table.isMutating(APPLY_PATH)).toBe(true);
    const { captured, handled } = await dispatchThroughPipeline(group, request, EXTERNAL_POLICY);

    expect(handled).toBe(true);
    expect(captured.status, captured.body).toBe(200);
    const parsed = AgentIntegrationsApplySuccessSchema.parse(JSON.parse(captured.body));
    expect(parsed.snapshot.probes.env).toBe('remote-web');
    expect(parsed.snapshot.probes.satisfiers['claude/skill/user/skill-bundle-copy']).toEqual({
      state: 'unprobed',
    });
    expect(probedScopes).not.toContain('user');
    expect(request.headers['x-forwarded-for']).toBeUndefined();
  });

  test.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])(
    'uses the local tier for loopback socket %s despite forwarded metadata',
    async (remoteAddress) => {
      const policy = buildIngressPolicy({});
      const probedScopes: string[] = [];
      const group = buildGroup({
        checkLocalOpSecurity: (req, res, opts) =>
          checkLocalOpSecurity(req, res, { ...opts, policy }),
        agentIntegrations: {
          probe: (item) => {
            probedScopes.push(item.scope);
            return { state: 'absent' };
          },
        },
      });
      const request = makeRequest(
        { intents: [] },
        {
          remoteAddress,
          headers: { 'x-forwarded-for': '203.0.113.8' },
        },
      );

      const { captured, handled } = await dispatchThroughPipeline(group, request, policy);

      expect(handled).toBe(true);
      expect(captured.status, captured.body).toBe(200);
      const parsed = AgentIntegrationsApplySuccessSchema.parse(JSON.parse(captured.body));
      expect(parsed.snapshot.probes.env).toBe('local-web');
      expect(probedScopes).toContain('user');
    },
  );

  test.each(ACTOR_CASES)('$label', async (actorCase) => {
    const policy = buildIngressPolicy({});
    const log = loggerFactory.getLogger(`agent-integrations-${actorCase.expectedActor}-test`);
    const info = vi.spyOn(log, 'info');
    const executorCalls: Parameters<StepExecutor>[] = [];
    const execute: StepExecutor = (...args) => {
      executorCalls.push(args);
      return { action: 'written' };
    };
    const group = buildGroup({
      log,
      getPrincipal: actorCase.getPrincipal,
      checkLocalOpSecurity: (req, res, opts) => checkLocalOpSecurity(req, res, { ...opts, policy }),
      agentIntegrations: {
        execute,
        probe: () => ({ state: 'absent' }),
      },
    });
    const request = makeRequest({
      intents: [{ satisfierId: 'claude/mcp/project/config-entry', desired: 'present' }],
      ...actorCase.body,
    });

    const { captured, handled } = await dispatchThroughPipeline(group, request, policy, log);

    expect(handled).toBe(true);
    expect(captured.status, captured.body).toBe(200);
    const parsed = AgentIntegrationsApplySuccessSchema.parse(JSON.parse(captured.body));
    expect(parsed.actions).toEqual([
      expect.objectContaining({
        satisfierId: 'claude/mcp/project/config-entry',
        action: 'written',
      }),
    ]);
    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0]).toHaveLength(1);
    const step = executorCalls[0]?.[0];
    expect(step).not.toHaveProperty('actor');
    expect(step).not.toHaveProperty('principalId');
    expect(step).not.toHaveProperty('writerId');
    const serializedStep = JSON.stringify(step);
    for (const forbidden of actorCase.forbiddenExecutorValues) {
      expect(serializedStep).not.toContain(forbidden);
    }
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      {
        actor: actorCase.expectedActor,
        applied: 1,
        failed: 0,
        conflicts: [],
      },
      '[agent-integrations] batch applied',
    );
  });

  test('runs the policy-bound local-operation gate before malformed body parsing', async () => {
    const strictPolicy = buildIngressPolicy({});
    let gateCalls = 0;
    let executorCalls = 0;
    const group = buildGroup({
      checkLocalOpSecurity: (req, res, opts) => {
        gateCalls += 1;
        return checkLocalOpSecurity(req, res, { ...opts, policy: strictPolicy });
      },
      agentIntegrations: {
        execute: () => {
          executorCalls += 1;
          return { action: 'written' };
        },
      },
    });
    const request = makeRequestBytes('{"intents":[', {
      remoteAddress: '203.0.113.8',
      host: 'integrations.example.com',
    });

    const { captured, handled } = await dispatchThroughPipeline(group, request, EXTERNAL_POLICY);

    expect(handled).toBe(true);
    expect(captured.status, captured.body).toBe(403);
    expect(parseProblem(captured.body)).toMatchObject({
      type: 'urn:ok:error:loopback-required',
      title: 'Local-op endpoints require a loopback connection.',
    });
    expect(gateCalls).toBe(1);
    expect(executorCalls).toBe(0);
    expect(request.readableEnded).toBe(false);
    request.destroy();
  });

  test('rejects a nonstring summary before actor extraction and execution', async () => {
    const policy = buildIngressPolicy({});
    const log = loggerFactory.getLogger('agent-integrations-summary-schema-test');
    const info = vi.spyOn(log, 'info');
    let principalReads = 0;
    let executorCalls = 0;
    const group = buildGroup({
      log,
      getPrincipal: () => {
        principalReads += 1;
        return FIXTURE_PRINCIPAL;
      },
      checkLocalOpSecurity: (req, res, opts) => checkLocalOpSecurity(req, res, { ...opts, policy }),
      agentIntegrations: {
        execute: () => {
          executorCalls += 1;
          return { action: 'written' };
        },
        probe: () => ({ state: 'absent' }),
      },
    });
    const request = makeRequest({
      intents: [{ satisfierId: 'claude/mcp/project/config-entry', desired: 'present' }],
      agentId: 'codex-actor',
      summary: 42,
    });

    const { captured, handled } = await dispatchThroughPipeline(group, request, policy, log);

    expect(handled).toBe(true);
    expect(captured.status, captured.body).toBe(400);
    expect(parseProblem(captured.body)).toMatchObject({
      type: 'urn:ok:error:invalid-request',
      title: 'Request body is invalid.',
    });
    expect(principalReads).toBe(0);
    expect(executorCalls).toBe(0);
    expect(info).not.toHaveBeenCalled();
  });

  test('dispatches the real apply handler and returns the flat success report', async () => {
    const resolution = buildGroup().table.resolve('/api/agent-integrations/apply');
    if (!resolution?.dispatch) throw new Error('apply route did not resolve');
    const { res, captured } = makeCaptureRes();
    await resolution.dispatch(makeRequest({ intents: [] }), res);
    expect(captured.status).toBe(200);
    const parsed = AgentIntegrationsApplySuccessSchema.parse(JSON.parse(captured.body));
    expect(parsed.actions).toEqual([]);
    expect(parsed.conflicts).toEqual([]);
    expect(parsed.withheld).toEqual([]);
    expect(parsed.snapshot.probes.env).toBe('local-web');
    expect(captured.body).not.toContain('"report"');
  });
});
