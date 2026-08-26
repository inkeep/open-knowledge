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

/**
 * Characterization: the natively-routed config + server-info read group.
 *
 * Two layers of proof, deliberately separated:
 *
 * 1. COMPOSED (booted rig): each route serves over a real socket through the
 *    multi-group `nativeApi` composition — the earlier groups' tables decline
 *    these URLs and the chain falls through here. These pins prove native
 *    registration and the read bodies; they do NOT re-assert the shared `/api/*`
 *    admission gates (foreign Origin, CORS, OPTIONS, forwarding, rebound Host),
 *    which `api-admission-composition.test.ts` owns — the pipeline applies them
 *    to every route, ported or not, so re-pinning them here would discriminate
 *    the pipeline, not this group.
 *
 * 2. HANDLER-LEVEL (no server): the inline loopback + Host / local-op gates
 *    live in the handler bodies, but the shared `/api/*` pipeline applies the
 *    same predicates before it dispatches any route, so no HTTP-level test can
 *    isolate them. The only layer where they are observable is the handler
 *    itself — reached by dispatching through the group's `table` directly,
 *    bypassing the pipeline. Those pins are what prove the inline gate survived
 *    the lift.
 */

const noopLog = {
  warn() {},
  error() {},
  debug() {},
  info() {},
  trace() {},
  fatal() {},
} as unknown as PinoLogger;

/**
 * Build the config-system group with stub deps for the handler-level gate
 * pins. `isRoutePeerAdmitted` / `isAllowedWorkspaceHostHeader` are the Host
 * gate's predicates (a realistic stub — the handler's own 403 is what the pin
 * observes); `checkLocalOpSecurity` is the REAL exported gate so the local-op
 * pin asserts its genuine URN + title, not a stub's.
 */
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

/** GET routes that serve a 200 read over the booted rig (no live egress / subprocess / real $HOME). */
const READ_200 = [
  '/api/config',
  '/api/config/diagnostics',
  '/api/server-info',
  '/api/semantic-status',
  '/api/workspace',
  '/api/rescue',
  '/api/__embed-detect',
];

/** Every route in the group — method-gated, so a POST answers 405 when registered. */
const ALL_ROUTES = [...READ_200, '/api/acp/catalog', '/api/installed-agents', '/api/principal'];

let tmpRoot: string;
let server: BootedServer;

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-config-system-native-'));
  const contentDir = mkdtempSync(resolve(tmpRoot, 'content-'));
  writeFileSync(resolve(contentDir, 'alpha.md'), '# Alpha\n\nBody.\n', 'utf-8');
  server = await bootCompositionRig(contentDir);
  await server.ready;
}, 60_000);

afterAll(async () => {
  await server?.destroy();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('config-system group over the composed listener — served natively', () => {
  test('every route in the group is registered natively (POST → 405 + Allow: GET)', async () => {
    // A native `fetch` from 127.0.0.1 carries a loopback Host and no Origin, so
    // the gated routes pass their loopback + Host gate and reach the method
    // check. An unregistered path would return the pipeline's generic
    // `/api/*` 404 instead of a 405.
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
    // `config` and `config/diagnostics` are the only two handlers in this
    // group that answer HEAD (a no-body 200 carrying the same headers as GET);
    // pin it so the manual HEAD emit survives the lift.
    for (const path of ['/api/config', '/api/config/diagnostics']) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { method: 'HEAD' });
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toBe('application/json');
      expect(res.headers.get('cache-control'), path).toBe('no-store');
      expect(await res.text(), path).toBe('');
    }
  });

  test('acp/catalog serves natively without depending on live CDN egress (200 or 502)', async () => {
    // The rig wires an `AcpRegistry` with no `fetchImpl` and a cold cache, so
    // the handler either serves an offline catalog (200) or emits its own
    // `502 registry-unreachable` when the CDN is unreachable — either proves
    // native serving without banking a network-dependent 200 on the required
    // `pnpm check` path. (A fixture `fetchImpl` seam for a deterministic 200 is
    // a follow-up, noted in the PR body.)
    const res = await fetch(`http://127.0.0.1:${server.port}/api/acp/catalog`);
    expect([200, 502]).toContain(res.status);
  });

  test('principal serves natively behind its inline gate (200 when resolvable, else its own 404)', async () => {
    // A native fetch passes the loopback + Host gate. Whether a principal
    // resolves depends on the host's git identity, so the pin accepts either
    // the 200 body or the handler's OWN 404 — never the pipeline route-miss.
    const res = await fetch(`http://127.0.0.1:${server.port}/api/principal`);
    expect([200, 404]).toContain(res.status);
    if (res.status === 404) {
      expect(((await res.json()) as { type?: string }).type).toBe(
        'urn:ok:error:principal-not-available',
      );
    }
  });

  test('both chained groups answer on one server (multi-group dispatch)', async () => {
    // The link/graph group resolves first in the chain; this group only
    // answers after the earlier groups decline. One server, both arms live.
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
    // The peer arm of the two-arm inline gate: a good Host but a non-admitted
    // peer address must still refuse (loopback-required), before method dispatch.
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
    // Driven through the REAL `checkLocalOpSecurity` (not a stub): a loopback
    // peer with a foreign Origin passes the peer check and fails the origin
    // check, so the gate emits its OWN title — distinct from the pipeline's
    // `'Origin not allowed.'`. Only observable here, since the pipeline's
    // origin gate would answer first over HTTP. The probe counter proves the
    // gate refuses BEFORE the handler does any OS-probe work.
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
    // handleApiConfig's HEAD branch sets res.statusCode directly (no writeHead),
    // so this pin passes only because makeCaptureRes carries the statusCode
    // fallback — the one construct no other pin here exercises.
    const out = await dispatch(buildConfigSystemRoutes(), '/api/config', { method: 'HEAD' });
    expect(out.status).toBe(200);
  });
});
