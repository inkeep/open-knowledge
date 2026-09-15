import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
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

const statSyncFaults = vi.hoisted(() => new Map<string, NodeJS.ErrnoException>());
const statSyncOverrides = vi.hoisted(() => new Map<string, unknown>());

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const statSync = ((path: Parameters<typeof fs.statSync>[0], options?: unknown) => {
    const fault = statSyncFaults.get(String(path));
    if (fault) throw fault;
    const override = statSyncOverrides.get(String(path));
    if (override !== undefined) return override;
    return (fs.statSync as (p: unknown, o?: unknown) => unknown)(path, options);
  }) as typeof fs.statSync;
  return { ...fs, statSync };
});

afterEach(() => {
  statSyncFaults.clear();
  statSyncOverrides.clear();
});

const noopLog = {
  warn() {},
  error() {},
  debug() {},
  info() {},
  trace() {},
  fatal() {},
} as unknown as PinoLogger;

function capturingLog(): { log: PinoLogger; warns: string[] } {
  const warns: string[] = [];
  const log = {
    warn: (_fields: unknown, message?: string) => {
      if (typeof message === 'string') warns.push(message);
    },
    error() {},
    debug() {},
    info() {},
    trace() {},
    fatal() {},
  } as unknown as PinoLogger;
  return { log, warns };
}

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

describe('flat rescue-buffer listing — nested documents', () => {
  let rescueRoot: string;

  function buildRescueGroup(
    gitDir: string,
    workTree: string,
    overrides: Partial<ConfigSystemRouteDeps> = {},
  ) {
    return buildConfigSystemRoutes({
      shadowRef: { current: { gitDir, workTree } },
      ...overrides,
    });
  }

  async function listRescue(
    group: ReturnType<typeof createConfigSystemRoutes>,
  ): Promise<Array<{ docName: string; size: number; source: string }>> {
    const resolved = group.table.resolve('/api/rescue');
    if (!resolved?.dispatch) throw new Error('no dispatch for /api/rescue');
    const req = makeSyntheticReq({ url: '/api/rescue' });
    const { res, captured } = makeCaptureRes();
    await resolved.dispatch(req, res);
    expect(captured.status).toBe(200);
    return JSON.parse(captured.body ?? '[]') as Array<{
      docName: string;
      size: number;
      source: string;
    }>;
  }

  function seedShadow(): { gitDir: string; workTree: string; rescueDir: string } {
    const gitDir = mkdtempSync(resolve(rescueRoot, 'git-'));
    const workTree = mkdtempSync(resolve(rescueRoot, 'work-'));
    const rescueDir = resolve(gitDir, 'rescue');
    mkdirSync(rescueDir, { recursive: true });
    return { gitDir, workTree, rescueDir };
  }

  beforeAll(() => {
    rescueRoot = mkdtempSync(resolve(tmpdir(), 'ok-rescue-nested-'));
  });

  afterAll(async () => {
    await rm(rescueRoot, { recursive: true, force: true });
  });

  test('a rescue buffer written for a nested docName is returned by the listing', async () => {
    const { gitDir, workTree, rescueDir } = seedShadow();
    mkdirSync(resolve(rescueDir, 'folder', 'sub'), { recursive: true });
    writeFileSync(resolve(rescueDir, 'folder', 'sub', 'doc.md'), '# Nested\n', 'utf-8');

    const entries = await listRescue(buildRescueGroup(gitDir, workTree));

    expect(entries.map((e) => e.docName)).toContain('folder/sub/doc');
  });

  test('top-level rescue buffers keep their existing entry shape', async () => {
    const { gitDir, workTree, rescueDir } = seedShadow();
    writeFileSync(resolve(rescueDir, 'alpha.md'), '# Alpha\n', 'utf-8');

    const entries = await listRescue(buildRescueGroup(gitDir, workTree));

    expect(entries).toHaveLength(1);
    expect(entries[0]?.docName).toBe('alpha');
    expect(entries[0]?.source).toBe('flat');
    expect(entries[0]?.size).toBe(8);
  });

  test('a stale nested rescue buffer is unlinked by the expiry sweep', async () => {
    const { gitDir, workTree, rescueDir } = seedShadow();
    const stalePath = resolve(rescueDir, 'folder', 'sub', 'stale.md');
    mkdirSync(resolve(rescueDir, 'folder', 'sub'), { recursive: true });
    writeFileSync(stalePath, '# Stale\n', 'utf-8');
    const ancient = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(stalePath, ancient, ancient);

    const entries = await listRescue(buildRescueGroup(gitDir, workTree));

    expect(entries.map((e) => e.docName)).not.toContain('folder/sub/stale');
    expect(existsSync(stalePath)).toBe(false);
  });

  test('the expiry sweep prunes the directories a stale nested buffer leaves empty', async () => {
    const { gitDir, workTree, rescueDir } = seedShadow();
    mkdirSync(resolve(rescueDir, 'folder', 'sub'), { recursive: true });
    const stalePath = resolve(rescueDir, 'folder', 'sub', 'stale.md');
    writeFileSync(stalePath, '# Stale\n', 'utf-8');
    const ancient = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(stalePath, ancient, ancient);

    await listRescue(buildRescueGroup(gitDir, workTree));

    expect(existsSync(resolve(rescueDir, 'folder'))).toBe(false);
    expect(existsSync(rescueDir)).toBe(true);
  });

  test('a live sibling keeps its directory when a stale nested buffer expires', async () => {
    const { gitDir, workTree, rescueDir } = seedShadow();
    mkdirSync(resolve(rescueDir, 'folder', 'sub'), { recursive: true });
    const stalePath = resolve(rescueDir, 'folder', 'sub', 'stale.md');
    writeFileSync(stalePath, '# Stale\n', 'utf-8');
    const ancient = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(stalePath, ancient, ancient);
    writeFileSync(resolve(rescueDir, 'folder', 'live.md'), '# Live\n', 'utf-8');

    const entries = await listRescue(buildRescueGroup(gitDir, workTree));

    expect(entries.map((e) => e.docName)).toEqual(['folder/live']);
    expect(existsSync(resolve(rescueDir, 'folder', 'sub'))).toBe(false);
    expect(existsSync(resolve(rescueDir, 'folder'))).toBe(true);
  });

  test('directory entries are never reported as rescue buffers', async () => {
    const { gitDir, workTree, rescueDir } = seedShadow();
    mkdirSync(resolve(rescueDir, 'looks-like-a-doc.md'), { recursive: true });
    writeFileSync(resolve(rescueDir, 'looks-like-a-doc.md', 'inner.md'), '# Inner\n', 'utf-8');

    const entries = await listRescue(buildRescueGroup(gitDir, workTree));

    expect(entries.map((e) => e.docName)).toEqual(['looks-like-a-doc.md/inner']);
  });

  test('the expiry sweep does not delete what a symlinked subdirectory points outside the rescue dir', async () => {
    const { gitDir, workTree, rescueDir } = seedShadow();
    const outside = mkdtempSync(resolve(rescueRoot, 'outside-'));
    mkdirSync(resolve(outside, 'deep'), { recursive: true });
    const victim = resolve(outside, 'deep', 'victim.md');
    writeFileSync(victim, '# Victim\n', 'utf-8');
    const ancient = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(victim, ancient, ancient);
    symlinkSync(outside, resolve(rescueDir, 'linked'), 'dir');

    const entries = await listRescue(buildRescueGroup(gitDir, workTree));

    expect(entries.map((e) => e.docName)).not.toContain('linked/deep/victim');
    expect(existsSync(victim)).toBe(true);
    expect(existsSync(resolve(outside, 'deep'))).toBe(true);
  });

  test('an unresolvable rescue entry is skipped without dropping the rest of the walk', async () => {
    const { gitDir, workTree, rescueDir } = seedShadow();
    const { log, warns } = capturingLog();
    symlinkSync(resolve(rescueDir, 'never-written.md'), resolve(rescueDir, 'dangling.md'), 'file');
    mkdirSync(resolve(rescueDir, 'folder'), { recursive: true });
    writeFileSync(resolve(rescueDir, 'folder', 'live.md'), '# Live\n', 'utf-8');

    const entries = await listRescue(buildRescueGroup(gitDir, workTree, { log }));

    expect(entries.map((e) => e.docName)).toEqual(['folder/live']);
    expect(warns).toContain('[rescue] skipping unresolvable rescue entry');
  });

  test.each(['ENOENT', 'EACCES', 'ELOOP', 'EIO'])(
    'a rescue entry failing to stat with %s is skipped without dropping the rest of the walk',
    async (code) => {
      const { gitDir, workTree, rescueDir } = seedShadow();
      const { log, warns } = capturingLog();
      const doomed = resolve(rescueDir, 'doomed.md');
      writeFileSync(doomed, '# Doomed\n', 'utf-8');
      mkdirSync(resolve(rescueDir, 'folder'), { recursive: true });
      writeFileSync(resolve(rescueDir, 'folder', 'live.md'), '# Live\n', 'utf-8');
      const fault: NodeJS.ErrnoException = new Error(`${code}: injected stat failure`);
      fault.code = code;
      statSyncFaults.set(realpathSync(doomed), fault);

      const entries = await listRescue(buildRescueGroup(gitDir, workTree, { log }));

      expect(entries.map((e) => e.docName)).toEqual(['folder/live']);
      expect(warns).toContain('[rescue] skipping uninspectable rescue entry');
    },
  );

  test('a rescue entry whose mtime cannot be serialized is skipped without dropping the rest of the walk', async () => {
    const { gitDir, workTree, rescueDir } = seedShadow();
    const { log, warns } = capturingLog();
    const doomed = resolve(rescueDir, 'doomed.md');
    writeFileSync(doomed, '# Doomed\n', 'utf-8');
    mkdirSync(resolve(rescueDir, 'folder'), { recursive: true });
    writeFileSync(resolve(rescueDir, 'folder', 'live.md'), '# Live\n', 'utf-8');
    const real = realpathSync(doomed);
    const actual = statSync(real);
    statSyncOverrides.set(real, {
      isFile: () => true,
      mtimeMs: actual.mtimeMs,
      mtime: new Date(Number.NaN),
      size: actual.size,
    });

    const entries = await listRescue(buildRescueGroup(gitDir, workTree, { log }));

    expect(entries.map((e) => e.docName)).toEqual(['folder/live']);
    expect(warns).toContain('[rescue] skipping uninspectable rescue entry');
  });
});
