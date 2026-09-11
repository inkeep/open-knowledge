import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentIntegrationsApplySuccessSchema,
  type ProbeResolver,
  type StepExecutor,
} from '@inkeep/open-knowledge-core';
import { afterEach, expect, test } from 'vitest';
import type { AgentRegistryHostSeam } from './agent-registry-apply.ts';
import type { BootedServer } from './boot.ts';
import {
  assertPathAbsentFromLegacyRegistry,
  bootCompositionRig,
  parseProblem,
  rawRequest,
} from './composition-rig.test-helper.ts';

const APPLY_PATH = '/api/agent-integrations/apply';
const CLAUDE_PROJECT_MCP = 'claude/mcp/project/config-entry';
const COPILOT_PROJECT_MCP = 'copilot/mcp/project/config-entry';
const COPILOT_PROJECT_SKILL = 'copilot/skill/project/skill-bundle-copy';
const COPILOT_USER_MCP = 'copilot/mcp/user/config-entry';
const SEEDED_CONFIG = '{\n  "unrelated": { "keep": true }\n}\n';

interface ApplyCompositionFixture {
  readonly root: string;
  readonly contentDir: string;
  readonly configPath: string;
  readonly server: BootedServer;
}

const fixtures: ApplyCompositionFixture[] = [];

function assertExclusiveNativeOwnership(server: BootedServer): void {
  expect(server.serverInstance.nativeApi.paths.filter((path) => path === APPLY_PATH)).toHaveLength(
    1,
  );
  const source = readFileSync(new URL('./api-extension.ts', import.meta.url), 'utf8');
  assertPathAbsentFromLegacyRegistry(source, APPLY_PATH);
}

async function bootApplyComposition(
  agentIntegrations: AgentRegistryHostSeam,
): Promise<ApplyCompositionFixture> {
  const root = mkdtempSync(join(tmpdir(), 'ok-agent-integrations-composition-'));
  const contentDir = join(root, 'project');
  const configPath = join(contentDir, '.mcp.json');
  mkdirSync(contentDir);
  writeFileSync(configPath, SEEDED_CONFIG, 'utf8');
  let server: BootedServer;
  try {
    server = await bootCompositionRig(contentDir, { agentIntegrations });
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  try {
    await server.ready;
    assertExclusiveNativeOwnership(server);
  } catch (error) {
    try {
      await server.destroy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    throw error;
  }
  const fixture = { root, contentDir, configPath, server };
  fixtures.push(fixture);
  return fixture;
}

async function postIntents(server: BootedServer, intents: readonly unknown[]) {
  return rawRequest(server.port, APPLY_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intents }),
  });
}

function settleWithin<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 4_000);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function observeNextRequest(server: BootedServer): Promise<{
  readonly partialBodyBytes: Promise<number>;
  readonly completedOnClose: Promise<boolean>;
}> {
  return new Promise((resolveRequest) => {
    server.httpServer.once('request', (request) => {
      const partialBodyBytes = new Promise<number>((resolveBytes) => {
        request.once('data', (chunk: Buffer) => resolveBytes(chunk.length));
      });
      const completedOnClose = new Promise<boolean>((resolveComplete) => {
        request.once('close', () => resolveComplete(request.complete));
      });
      resolveRequest({ partialBodyBytes, completedOnClose });
    });
  });
}

async function interruptPartialApply(server: BootedServer): Promise<{
  readonly acceptedBytes: number;
  readonly completed: boolean;
}> {
  const observedRequest = observeNextRequest(server);
  const socket = connect(server.port, '127.0.0.1');
  await settleWithin(
    new Promise<void>((resolveConnected, reject) => {
      socket.once('connect', resolveConnected);
      socket.once('error', reject);
    }),
    'socket connection',
  );
  const body = `{"intents":[{"satisfierId":"${CLAUDE_PROJECT_MCP}","desired":"present"}`;
  const request = [
    `POST ${APPLY_PATH} HTTP/1.1`,
    `Host: 127.0.0.1:${server.port}`,
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body) + 128}`,
    '',
    body,
  ].join('\r\n');
  socket.write(request);
  const lifecycle = await settleWithin(observedRequest, 'request acceptance');
  const acceptedBytes = await settleWithin(lifecycle.partialBodyBytes, 'partial request body');
  socket.destroy();
  const completed = await settleWithin(lifecycle.completedOnClose, 'incomplete request close');
  return { acceptedBytes, completed };
}

afterEach(async () => {
  const current = fixtures.splice(0);
  const destroyed = await Promise.allSettled(current.map(({ server }) => server.destroy()));
  for (const { root } of current) rmSync(root, { recursive: true, force: true });
  const failures = destroyed.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length > 0)
    throw new AggregateError(failures, 'composition fixture teardown failed');
});

test('independent integration work continues after an executor failure', async () => {
  let executionStarted = false;
  const executionOrder: string[] = [];
  const probe: ProbeResolver = (item) => {
    if (executionStarted) throw new Error('host probes unavailable');
    return { state: item.satisfierId === COPILOT_USER_MCP ? 'satisfied' : 'absent' };
  };
  const execute: StepExecutor = (step) => {
    executionStarted = true;
    executionOrder.push(step.satisfierId);
    if (step.satisfierId === CLAUDE_PROJECT_MCP) throw new Error('first write failed');
    return { action: 'written' };
  };
  const { server } = await bootApplyComposition({ probe, execute });

  const response = await postIntents(server, [
    { satisfierId: CLAUDE_PROJECT_MCP, desired: 'present' },
    { satisfierId: COPILOT_PROJECT_SKILL, desired: 'present' },
  ]);

  expect(response.status).toBe(200);
  const result = AgentIntegrationsApplySuccessSchema.parse(JSON.parse(response.body));
  expect(executionOrder).toEqual([CLAUDE_PROJECT_MCP, COPILOT_PROJECT_SKILL]);
  expect(
    result.actions.map(({ satisfierId, action, errorId }) => ({ satisfierId, action, errorId })),
  ).toEqual([
    {
      satisfierId: CLAUDE_PROJECT_MCP,
      action: 'failed',
      errorId: 'executor-threw',
    },
    {
      satisfierId: COPILOT_PROJECT_SKILL,
      action: 'written',
      errorId: undefined,
    },
  ]);
  expect(result.snapshot.probes.env).toBe('local-web');
  expect(Object.keys(result.snapshot.probes.satisfiers).length).toBeGreaterThan(0);
  expect(
    Object.values(result.snapshot.probes.satisfiers).every(({ state }) => state === 'unprobed'),
  ).toBe(true);
});

test('a shared project entry is withheld while another owner still uses it', async () => {
  const executionOrder: string[] = [];
  const probe: ProbeResolver = (item) => ({
    state:
      item.satisfierId === CLAUDE_PROJECT_MCP || item.satisfierId === COPILOT_PROJECT_MCP
        ? 'satisfied'
        : 'absent',
  });
  const execute: StepExecutor = (step) => {
    executionOrder.push(step.satisfierId);
    return { action: 'removed' };
  };
  const { server, configPath } = await bootApplyComposition({ probe, execute });

  const response = await postIntents(server, [
    { satisfierId: CLAUDE_PROJECT_MCP, desired: 'absent' },
  ]);

  expect(response.status).toBe(200);
  const result = AgentIntegrationsApplySuccessSchema.parse(JSON.parse(response.body));
  expect(result.actions).toEqual([]);
  expect(result.conflicts.map(({ kind }) => kind)).toContain('unresolved-shared-copy');
  expect(result.withheld).toContain(CLAUDE_PROJECT_MCP);
  expect(executionOrder).toEqual([]);
  expect(readFileSync(configPath, 'utf8')).toBe(SEEDED_CONFIG);
});

test('admission, method, and schema refusals prevent integration execution', async () => {
  let executionCount = 0;
  const { server, configPath } = await bootApplyComposition({
    probe: () => ({ state: 'absent' }),
    execute: () => {
      executionCount += 1;
      return { action: 'written' };
    },
  });
  const malformedWrite = `{"intents":[{"satisfierId":"${CLAUDE_PROJECT_MCP}","desired":"present"}`;

  const rejectedHost = await rawRequest(server.port, APPLY_PATH, {
    method: 'POST',
    headers: { Host: 'evil.example', 'Content-Type': 'application/json' },
    body: malformedWrite,
  });
  expect(rejectedHost.status).toBe(403);
  expect(parseProblem(rejectedHost.body).type).toBe('urn:ok:error:host-not-allowed');

  const rejectedMethod = await rawRequest(server.port, APPLY_PATH, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: malformedWrite,
  });
  expect(rejectedMethod.status).toBe(405);
  expect(rejectedMethod.headers.allow).toBe('POST');
  expect(parseProblem(rejectedMethod.body).type).toBe('urn:ok:error:method-not-allowed');

  const rejectedBody = await rawRequest(server.port, APPLY_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      intents: [{ satisfierId: CLAUDE_PROJECT_MCP, desired: 'present' }],
      summary: 7,
    }),
  });
  expect(rejectedBody.status).toBe(400);
  expect(parseProblem(rejectedBody.body)).toMatchObject({
    type: 'urn:ok:error:invalid-request',
    title: 'Request body is invalid.',
  });
  expect(executionCount).toBe(0);
  expect(readFileSync(configPath, 'utf8')).toBe(SEEDED_CONFIG);
});

test('an interrupted partial apply has no effect and the listener stays usable', async () => {
  let executionCount = 0;
  const { server, configPath } = await bootApplyComposition({
    probe: () => ({ state: 'absent' }),
    execute: () => {
      executionCount += 1;
      return { action: 'written' };
    },
  });

  const interrupted = await interruptPartialApply(server);

  expect(interrupted.acceptedBytes).toBeGreaterThan(0);
  expect(interrupted.completed).toBe(false);
  expect(executionCount).toBe(0);
  expect(readFileSync(configPath, 'utf8')).toBe(SEEDED_CONFIG);

  const nextResponse = await postIntents(server, []);
  expect(nextResponse.status).toBe(200);
  const nextResult = AgentIntegrationsApplySuccessSchema.parse(JSON.parse(nextResponse.body));
  expect(nextResult.actions).toEqual([]);
  expect(executionCount).toBe(0);
  expect(readFileSync(configPath, 'utf8')).toBe(SEEDED_CONFIG);
}, 15_000);
