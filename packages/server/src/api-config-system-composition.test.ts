import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import {
  bootCompositionRig,
  makeCaptureRes,
  makeSyntheticReq,
} from './composition-rig.test-helper.ts';
import {
  type ConfigSystemRouteDeps,
  createConfigSystemRoutes,
} from './http/config-system-routes.ts';
import { checkLocalOpSecurity } from './local-op-security.ts';
import type { PinoLogger } from './logger.ts';

const noopLog = {
  warn() {},
  error() {},
  debug() {},
  info() {},
  trace() {},
  fatal() {},
} as unknown as PinoLogger;

function buildConfigSystemRoutes(overrides: Partial<ConfigSystemRouteDeps> = {}) {
  return createConfigSystemRoutes({
    contentDir: '/tmp/ok-config-system-unit',
    projectDir: undefined,
    ephemeral: false,
    log: noopLog,
    ready: undefined,
    durabilityState: { getActiveBranch: () => 'main' },
    serverInstanceId: 'test-instance',
    getDiskAckSVs: undefined,
    getCollabClientCount: undefined,
    getConfigDiagnostics: undefined,
    acpRegistry: undefined,
    loadAcpCustomAgents: undefined,
    acpHarnessAvailability: (async () => ({})) as ConfigSystemRouteDeps['acpHarnessAvailability'],
    isRoutePeerAdmitted: () => true,
    isAllowedWorkspaceHostHeader: (host) => host === '127.0.0.1',
    checkLocalOpSecurity,
    getPrincipal: undefined,
    semanticSearch: undefined,
    readSemanticProviderConfig: undefined,
    embeddingsSecretsFile: undefined,
    getFileIndex: () => new Map(),
    shadowRef: undefined,
    getCurrentBranch: undefined,
    installedAgentsCache: {
      probeAll: (async () => ({})) as ConfigSystemRouteDeps['installedAgentsCache']['probeAll'],
    },
    ...overrides,
  });
}

async function dispatch(
  group: ReturnType<typeof createConfigSystemRoutes>,
  path: string,
  reqOpts: Parameters<typeof makeSyntheticReq>[0],
): Promise<{ status: number; body: { type?: string; title?: string }; allow: unknown }> {
  const resolved = group.table.resolve(path);
  if (!resolved?.dispatch) throw new Error(`no dispatch for ${path}`);
  const req = makeSyntheticReq({ url: path, ...reqOpts });
  const { res, captured } = makeCaptureRes();
  await resolved.dispatch(req, res);
  return {
    status: captured.status,
    body: captured.body ? (JSON.parse(captured.body) as { type?: string; title?: string }) : {},
    allow: captured.headers.allow,
  };
}

const READ_200 = [
  '/api/config',
  '/api/config/diagnostics',
  '/api/server-info',
  '/api/semantic-status',
  '/api/workspace',
  '/api/rescue',
  '/api/__embed-detect',
];

const ALL_ROUTES = [...READ_200, '/api/acp/catalog', '/api/installed-agents', '/api/principal'];

let tmpRoot: string;
let server: BootedServer;

const acpRegistryRequests: string[] = [];

const acpRegistryFetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
  acpRegistryRequests.push(new Request(input as RequestInfo).url);
  return new Response('{"agents":[]}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-config-system-native-'));
  const contentDir = mkdtempSync(resolve(tmpRoot, 'content-'));
  writeFileSync(resolve(contentDir, 'alpha.md'), '# Alpha\n\nBody.\n', 'utf-8');
  server = await bootCompositionRig(contentDir, { acpRegistryFetchImpl });
  await server.ready;
}, 60_000);

afterAll(async () => {
  await server?.destroy();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('config-system group over the composed listener — served natively', () => {
  test('every route in the group is registered natively (POST → 405 + Allow: GET)', async () => {
    for (const path of ALL_ROUTES) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { method: 'POST' });
      expect(res.status, path).toBe(405);
      expect(res.headers.get('allow'), path).toContain('GET');
    }
  });

  test('every read serves a 200 body natively (application/json + x-request-id)', async () => {
    for (const path of READ_200) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toBe('application/json');
      expect(res.headers.get('x-request-id'), path).not.toBeNull();
    }
  });

  test('HEAD on the config endpoints answers 200 with headers and no body', async () => {
    for (const path of ['/api/config', '/api/config/diagnostics']) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { method: 'HEAD' });
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toBe('application/json');
      expect(res.headers.get('cache-control'), path).toBe('no-store');
      expect(await res.text(), path).toBe('');
    }
  });

  test('acp/catalog serves natively against a stubbed registry (200, no live CDN egress)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/acp/catalog`);
    expect(res.status).toBe(200);
    expect(acpRegistryRequests).toEqual([
      'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json',
    ]);
  });

  test('principal serves natively behind its inline gate (200 when resolvable, else its own 404)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/principal`);
    expect([200, 404]).toContain(res.status);
    if (res.status === 404) {
      expect(((await res.json()) as { type?: string }).type).toBe(
        'urn:ok:error:principal-not-available',
      );
    }
  });

  test('both chained groups answer on one server (multi-group dispatch)', async () => {
    const linkGraph = await fetch(`http://127.0.0.1:${server.port}/api/backlinks?docName=alpha`);
    expect(linkGraph.status).toBe(200);
    const config = await fetch(`http://127.0.0.1:${server.port}/api/config`);
    expect(config.status).toBe(200);
  });
});

describe('config-system inline gates — observable only at the handler layer', () => {
  test('the Host-gated reads emit a handler-owned 403 on a hostile Host', async () => {
    for (const path of ['/api/principal', '/api/workspace', '/api/__embed-detect']) {
      const out = await dispatch(buildConfigSystemRoutes(), path, { host: 'evil.example' });
      expect(out.status, path).toBe(403);
      expect(out.body.type, path).toBe('urn:ok:error:host-not-allowed');
    }
  });

  test('the Host-gated reads emit a handler-owned 403 when the peer is not admitted', async () => {
    for (const path of ['/api/principal', '/api/workspace', '/api/__embed-detect']) {
      const out = await dispatch(
        buildConfigSystemRoutes({ isRoutePeerAdmitted: () => false }),
        path,
        {
          host: '127.0.0.1',
        },
      );
      expect(out.status, path).toBe(403);
      expect(out.body.type, path).toBe('urn:ok:error:loopback-required');
    }
  });

  test('the inline Host gate fires BEFORE method dispatch (POST + hostile Host → 403, no Allow)', async () => {
    for (const path of ['/api/principal', '/api/workspace', '/api/__embed-detect']) {
      const out = await dispatch(buildConfigSystemRoutes(), path, {
        method: 'POST',
        host: 'evil.example',
      });
      expect(out.status, path).toBe(403);
      expect(out.body.type, path).toBe('urn:ok:error:host-not-allowed');
      expect(out.allow, path).toBeUndefined();
    }
  });

  test('installed-agents short-circuits on checkLocalOpSecurity (foreign Origin → its own invalid-origin)', async () => {
    let probes = 0;
    const group = buildConfigSystemRoutes({
      installedAgentsCache: {
        probeAll: (async () => {
          probes += 1;
          return {};
        }) as ConfigSystemRouteDeps['installedAgentsCache']['probeAll'],
      },
    });
    const out = await dispatch(group, '/api/installed-agents', {
      remoteAddress: '127.0.0.1',
      origin: 'https://evil.example.com',
    });
    expect(out.status).toBe(403);
    expect(out.body.type).toBe('urn:ok:error:invalid-origin');
    expect(out.body.title).toBe('Origin header is not a permitted loopback origin.');
    expect(probes).toBe(0);
  });

  test('HEAD reaches the config handler through direct dispatch (statusCode fallback surfaces 200)', async () => {
    const out = await dispatch(buildConfigSystemRoutes(), '/api/config', { method: 'HEAD' });
    expect(out.status).toBe(200);
  });
});
