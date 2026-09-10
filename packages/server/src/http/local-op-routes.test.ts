import { createServer, type Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, test } from 'vitest';
import { createConcurrencyGuard } from '../local-op-security.ts';
import type { AuthEvent } from '../local-ops/types.ts';
import { loggerFactory } from '../logger.ts';
import { listenOnLoopback } from '../loopback-rig-test-helpers.ts';
import type { SyncEngine } from '../sync-engine.ts';
import { createLocalOpRoutes, resumeSyncOnAuthEvent } from './local-op-routes.ts';

const LOCAL_OP_PATHS = [
  '/api/local-op/clone',
  '/api/local-op/ok-init',
  '/api/local-op/auth/login',
  '/api/local-op/auth/status',
  '/api/local-op/auth/pat',
  '/api/local-op/auth/gh-login',
  '/api/local-op/auth/cancel',
  '/api/local-op/auth/repos',
  '/api/local-op/auth/signout',
  '/api/local-op/auth/set-identity',
  '/api/local-op/embeddings/set-key',
  '/api/local-op/embeddings/clear-key',
  '/api/local-op/embeddings/test',
];

type LocalOpRouteDeps = Parameters<typeof createLocalOpRoutes>[0];

function buildGroup(overrides: Partial<LocalOpRouteDeps> = {}) {
  return createLocalOpRoutes({
    projectDir: undefined,
    contentDir: '/tmp/ok-local-op-routes-test',
    log: loggerFactory.getLogger('test'),
    checkLocalOpSecurity: () => true,
    localOpCliArgs: ['open-knowledge'],
    localOpGuard: createConcurrencyGuard(),
    getSyncEngine: undefined,
    authStreamHeartbeatMs: undefined,
    embeddingsSecretsFile: undefined,
    readSemanticProviderConfig: undefined,
    semanticSearch: undefined,
    ...overrides,
  });
}

describe('createLocalOpRoutes table', () => {
  test('claims the namespace with a single wildcard and resolves all thirteen members', () => {
    const group = buildGroup();
    expect([...group.paths]).toEqual(['/api/local-op/*']);
    for (const path of LOCAL_OP_PATHS) {
      const resolution = group.table.resolve(path);
      expect(resolution?.template, path).toBe(path);
      expect(resolution?.dispatch, path).toBeDefined();
    }
  });

  test('every registered member is mutating (prefix-family membership)', () => {
    const { table } = buildGroup();
    for (const path of LOCAL_OP_PATHS) {
      expect(table.isMutating(path), path).toBe(true);
    }
  });

  test('an unregistered member is owned by the namespace leg, 404-bound, and mutating by default', () => {
    const { table } = buildGroup();
    const resolution = table.resolve('/api/local-op/some-future-op');
    expect(resolution).not.toBeNull();
    expect(resolution?.template).toBe('/api/local-op/:op');
    expect(resolution?.dispatch).toBeUndefined();
    expect(table.isMutating('/api/local-op/some-future-op')).toBe(true);
  });

  test('a bare-prefix sibling outside the family is not owned and not mutating', () => {
    const { table } = buildGroup();
    expect(table.resolve('/api/local-op-status')).toBeNull();
    expect(table.isMutating('/api/local-op-status')).toBe(false);
  });
});

describe('resumeSyncOnAuthEvent (reconnect → resume wiring)', () => {
  const makeEngineStub = (impl?: () => Promise<void>) => {
    const calls: number[] = [];
    const refreshCalls: number[] = [];
    const engine = {
      notifyCredentialsChanged: () => {
        calls.push(Date.now());
        return impl ? impl() : Promise.resolve();
      },
      refreshPushPermission: () => {
        refreshCalls.push(Date.now());
        return Promise.resolve(null);
      },
    } as unknown as SyncEngine;
    return { engine, calls, refreshCalls, getSyncEngine: () => engine };
  };

  const completeEvent: AuthEvent = { type: 'complete', host: 'github.com', login: 'octocat' };
  const verificationEvent: AuthEvent = {
    type: 'verification',
    user_code: 'ABCD-1234',
    verification_uri: 'https://github.com/login/device',
    expires_in: 900,
  };
  const errorEvent: AuthEvent = { type: 'error', message: 'denied' };

  test('a complete event resumes sync AND re-probes push permission', () => {
    const stub = makeEngineStub();
    resumeSyncOnAuthEvent(completeEvent, stub.getSyncEngine);
    expect(stub.calls.length).toBe(1);
    expect(stub.refreshCalls.length).toBe(1);
  });

  test('non-complete events do not resume sync or re-probe', () => {
    const stub = makeEngineStub();
    resumeSyncOnAuthEvent(verificationEvent, stub.getSyncEngine);
    resumeSyncOnAuthEvent(errorEvent, stub.getSyncEngine);
    expect(stub.calls.length).toBe(0);
    expect(stub.refreshCalls.length).toBe(0);
  });

  test('absent getSyncEngine is a no-op (engine dormant / not yet constructed)', () => {
    expect(() => resumeSyncOnAuthEvent(completeEvent, undefined)).not.toThrow();
  });

  test('a null engine is a no-op', () => {
    expect(() => resumeSyncOnAuthEvent(completeEvent, () => null)).not.toThrow();
  });

  test('a rejected notifyCredentialsChanged is swallowed (best-effort)', async () => {
    const stub = makeEngineStub(() => Promise.reject(new Error('boom')));
    expect(() => resumeSyncOnAuthEvent(completeEvent, stub.getSyncEngine)).not.toThrow();
    expect(stub.calls.length).toBe(1);
    await Promise.resolve();
  });
});

const DEVICE_FLOW_BACKSTOP_MS = 20_000;

function parkedDeviceFlowCli(): string[] {
  return [
    process.execPath,
    '-e',
    `
      console.log(
        JSON.stringify({
          type: 'verification',
          user_code: 'WDJB-MJHT',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
        }),
      );
      setTimeout(() => process.exit(1), ${DEVICE_FLOW_BACKSTOP_MS});
    `,
  ];
}

type StreamLine = Record<string, unknown>;

async function* ndjsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamLine> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      const trailing = buffer.trim();
      if (trailing) yield JSON.parse(trailing) as StreamLine;
      return;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      yield JSON.parse(line) as StreamLine;
    }
  }
}

describe('auth-login stream displacement (a second start orphans the first client)', () => {
  let servers: HttpServer[] = [];

  afterEach(async () => {
    const active = servers;
    servers = [];
    await Promise.allSettled(
      active.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  async function serveLocalOpGroup(overrides: Partial<LocalOpRouteDeps> = {}): Promise<string> {
    const group = buildGroup(overrides);
    const server = createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      const dispatch = group.table.resolve(pathname)?.dispatch;
      if (!dispatch) {
        res.writeHead(404).end();
        return;
      }
      void dispatch(req, res);
    });
    const { baseUrl } = await listenOnLoopback(server);
    servers.push(server);
    return baseUrl;
  }

  const postJson = (baseUrl: string, path: string, body: unknown): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  test('the displaced stream is told it was replaced before the server ends it', async () => {
    const baseUrl = await serveLocalOpGroup({ localOpCliArgs: parkedDeviceFlowCli() });

    const first = await postJson(baseUrl, '/api/local-op/auth/login', { host: 'github.com' });
    expect(first.status).toBe(200);
    if (!first.body) throw new Error('first login stream has no body');
    const firstLines = ndjsonLines(first.body);
    expect((await firstLines.next()).value).toMatchObject({ type: 'verification' });

    const second = await postJson(baseUrl, '/api/local-op/auth/login', { host: 'github.com' });
    expect(second.status).toBe(200);
    if (!second.body) throw new Error('second login stream has no body');

    const remainder: StreamLine[] = [];
    for await (const line of firstLines) remainder.push(line);

    const terminal = remainder.filter((line) => line.type !== 'ping').at(-1);
    expect(terminal).toMatchObject({
      type: 'error',
      problem: {
        type: 'urn:ok:error:concurrent-operation',
        status: 409,
        title: 'Sign-in was replaced by a newer sign-in attempt.',
      },
    });

    await postJson(baseUrl, '/api/local-op/auth/cancel', {});
    const secondLines: StreamLine[] = [];
    for await (const line of ndjsonLines(second.body)) secondLines.push(line);
    expect(secondLines.some((line) => line.type === 'verification')).toBe(true);
  }, 30_000);
});
