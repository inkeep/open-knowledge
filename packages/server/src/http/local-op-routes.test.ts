import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createConcurrencyGuard } from '../local-op-security.ts';
import * as ghLogin from '../local-ops/gh-login.ts';
import type { AuthEvent } from '../local-ops/types.ts';
import { loggerFactory } from '../logger.ts';
import { listenOnLoopback } from '../loopback-rig-test-helpers.ts';
import { declareGitHubHosts, useIsolatedHome } from '../share/git-host-declarations.test-helper.ts';
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
    contentDir: tmpdir(),
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
  const home = useIsolatedHome();

  let servers: HttpServer[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
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

  test('a project whose origin is not a GitHub host refuses GitHub auth routes that name no host', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-local-op-non-github-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: projectDir });
      execFileSync('git', ['remote', 'add', 'origin', 'https://git.example.internal/team/kb.git'], {
        cwd: projectDir,
      });
      const baseUrl = await serveLocalOpGroup({
        projectDir,
        localOpCliArgs: parkedDeviceFlowCli(),
      });

      for (const path of [
        '/api/local-op/auth/status',
        '/api/local-op/auth/login',
        '/api/local-op/auth/pat',
        '/api/local-op/auth/gh-login',
        '/api/local-op/auth/repos',
        '/api/local-op/auth/signout',
      ]) {
        const body = path.endsWith('/pat') ? { token: 'ghp_test' } : {};
        const res = await postJson(baseUrl, path, body);
        expect(res.status, path).toBe(409);
        expect(await res.json(), path).toMatchObject({
          type: 'urn:ok:error:non-github-origin',
          host: 'git.example.internal',
          detail: expect.stringContaining('git.example.internal'),
        });
      }

      const explicit = await postJson(baseUrl, '/api/local-op/auth/login', { host: 'github.com' });
      expect(explicit.status).toBe(200);
      await postJson(baseUrl, '/api/local-op/auth/cancel', {});
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('gh-login rejects an explicit undeclared host before looking up gh and accepts a declaration', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-gh-login-host-'));
    const probe = vi.spyOn(ghLogin, 'cachedGhBinaryPath').mockResolvedValue(null);
    try {
      const baseUrl = await serveLocalOpGroup({ projectDir });
      const rejected = await postJson(baseUrl, '/api/local-op/auth/gh-login', {
        host: 'ghes.example.test',
      });
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toMatchObject({ host: 'ghes.example.test' });
      expect(probe).not.toHaveBeenCalled();
      declareGitHubHosts(home(), 'ghes.example.test');
      const beforeRestart = await postJson(baseUrl, '/api/local-op/auth/gh-login', {
        host: 'ghes.example.test',
      });
      expect(beforeRestart.status).toBe(409);
      expect(probe).not.toHaveBeenCalled();
      const restartedUrl = await serveLocalOpGroup({ projectDir });
      const accepted = await postJson(restartedUrl, '/api/local-op/auth/gh-login', {
        host: 'ghes.example.test',
      });
      expect(accepted.status).toBe(400);
      expect(await accepted.json()).toMatchObject({
        title: 'The GitHub CLI (gh) is not installed.',
      });
      expect(probe).toHaveBeenCalledOnce();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('normalizes rejected explicit hosts without changing accepted network ports', async () => {
    const projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-auth-normalized-host-')));
    try {
      const localOpCliArgs = [
        process.execPath,
        '-e',
        `console.log(JSON.stringify({type: 'complete', host: process.argv[process.argv.indexOf('--host') + 1], login: 'octocat'}));`,
      ];
      const baseUrl = await serveLocalOpGroup({ projectDir, localOpCliArgs });
      const rejected = await postJson(baseUrl, '/api/local-op/auth/login', {
        host: 'GHES.Example.test:8443',
      });
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toMatchObject({
        host: 'ghes.example.test',
        detail: expect.stringContaining('git.hosts.ghes.example.test.provider'),
      });
      const declaredUrl = await serveLocalOpGroup({
        projectDir,
        localOpCliArgs,
        declaredGitHubHosts: new Set(['ghes.example.test']),
      });
      const accepted = await postJson(declaredUrl, '/api/local-op/auth/login', {
        host: 'GHES.Example.test:8443',
      });
      expect(accepted.status).toBe(200);
      expect(await accepted.text()).toContain('"host":"GHES.Example.test:8443"');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('explicit undeclared hosts are refused except for local credential deletion', async () => {
    const projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-auth-explicit-host-')));
    try {
      const localOpCliArgs = [process.execPath, '-e', 'process.exit(0)'];
      const baseUrl = await serveLocalOpGroup({ projectDir, localOpCliArgs });
      for (const verb of ['login', 'status', 'pat', 'repos']) {
        const response = await postJson(baseUrl, `/api/local-op/auth/${verb}`, {
          host: 'git.example.test',
          ...(verb === 'pat' ? { token: 'test-token' } : {}),
        });
        expect(response.status, verb).toBe(409);
        expect(await response.json()).toMatchObject({ host: 'git.example.test' });
      }
      const response = await postJson(baseUrl, '/api/local-op/auth/signout', {
        host: 'git.example.test',
      });
      expect(response.status).toBe(200);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('an unparseable origin reports an unknown host without a false provider classification', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-unparseable-origin-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: projectDir });
      execFileSync('git', ['remote', 'add', 'origin', '../other-repository'], { cwd: projectDir });
      const baseUrl = await serveLocalOpGroup({ projectDir });
      const response = await postJson(baseUrl, '/api/local-op/auth/status', {});
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        host: null,
        detail: expect.stringContaining('could not be parsed'),
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('auth subprocesses run in the project directory instead of the server cwd', async () => {
    const projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-auth-cwd-')));
    vi.spyOn(ghLogin, 'cachedGhBinaryPath').mockResolvedValue(null);
    try {
      const localOpCliArgs = [
        process.execPath,
        '-e',
        `
        const fs = require('node:fs');
        const verb = process.argv[2];
        fs.writeFileSync(verb + '.cwd', process.cwd());
        const fields = {host: 'github.com', login: 'octocat', authenticated: true};
        console.log(JSON.stringify({type: verb === 'status' ? 'status' : verb === 'repos' ? 'repos' : 'complete', ...fields, repos: []}));
      `,
      ];
      const baseUrl = await serveLocalOpGroup({ projectDir, localOpCliArgs });
      for (const verb of ['login', 'status', 'pat', 'repos', 'signout']) {
        const response = await postJson(
          baseUrl,
          `/api/local-op/auth/${verb}`,
          verb === 'pat' ? { token: 'ghp_test' } : {},
        );
        expect(response.status, verb).toBe(200);
        await response.text();
        expect(readFileSync(join(projectDir, `${verb}.cwd`), 'utf8'), verb).toBe(projectDir);
      }
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
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
