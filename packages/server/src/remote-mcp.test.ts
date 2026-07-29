/**
 * Remote access — mount-level admission matrix for the trust-the-tunnel model.
 *
 * Boots the REAL `mountMcpAndApi` + `createMcpHttpHandler` on a loopback
 * port, then plays remote callers by shaping requests the way any tunnel's
 * local agent delivers them: loopback TCP peer + the tunnel's public Host
 * (+ the forwarding headers proxies inject). That is byte-for-byte what the
 * server sees behind a real ngrok / cloudflared / tailscale tunnel — the
 * transport itself is the only untested hop.
 *
 * With remote enabled there is ONE gate: Host on the allowlist (loopback
 * names or the tunnel's public host) over a loopback socket. Admitted
 * callers get the full surface; there is no per-origin tiering and no
 * server-side auth — restricting WHO can reach the tunnel is the tunnel's
 * job (edge auth). With remote disabled, proxied requests trip the
 * forwarding-header tripwire instead of inheriting local trust.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import {
  createServer as createHttpServer,
  type Server as HttpServer,
  request as httpRequest,
} from 'node:http';
import { connect as createNetConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hocuspocus } from '@hocuspocus/server';
import { afterEach, describe, expect, test } from 'vitest';
import { ConfigSchema } from './config/schema.ts';
import { getFreeLoopbackPort } from './loopback-rig-test-helpers.ts';
import { createMcpHttpHandler, type McpHttpHandler } from './mcp-http.ts';
import { type MountMcpAndApiHandle, mountMcpAndApi } from './mcp-mount.ts';
import { resolveRemoteAccess } from './remote-access.ts';

const MCP_PROTOCOL_VERSION = '2025-06-18';
const PUBLIC_URL = 'https://myproject.ngrok.app';
const PUBLIC_HOST = 'myproject.ngrok.app';

/** What any tunnel's local agent delivers: public Host over a loopback socket. */
const TUNNEL_HEADERS = { host: PUBLIC_HOST };
/** Same, with the forwarding headers mainstream tunnels inject. */
const TUNNEL_FORWARDED_HEADERS = {
  host: PUBLIC_HOST,
  'x-forwarded-for': '203.0.113.7',
  'x-forwarded-proto': 'https',
};

const log = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => log,
} as never;

const hocuspocus = {
  hooks: async () => {},
  handleConnection: () => ({ handleMessage: () => {}, handleClose: () => {} }),
} as unknown as Hocuspocus;

interface Rig {
  port: number;
  contentDir: string;
  cleanup: () => Promise<void>;
}

let rigs: Rig[] = [];

afterEach(async () => {
  await Promise.allSettled(rigs.map((r) => r.cleanup()));
  rigs = [];
});

interface RigExtras {
  reactShellMiddleware?: (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    next: () => void,
  ) => void;
  /** Stub thread manager to exercise the `/collab/thread` admission gate. */
  acpThreadManager?: unknown;
}

async function bootRemoteRig(
  remote: Record<string, unknown>,
  extras: RigExtras = {},
): Promise<Rig> {
  const contentDir = mkdtempSync(join(tmpdir(), 'ok-remote-mcp-'));
  const localDir = join(contentDir, '.ok', 'local');
  mkdirSync(localDir, { recursive: true });
  const config = ConfigSchema.parse({ remote });
  const remoteAccess = resolveRemoteAccess(config);
  const port = await getFreeLoopbackPort();
  const handler: McpHttpHandler = createMcpHttpHandler({
    contentDir,
    projectDir: contentDir,
    config,
    getServerUrl: () => `http://127.0.0.1:${port}`,
  });
  const httpServer: HttpServer = createHttpServer();
  const mount: MountMcpAndApiHandle = mountMcpAndApi({
    httpServer,
    hocuspocus,
    mcpHttpHandler: handler,
    remoteAccess,
    ...(extras.reactShellMiddleware ? { reactShellMiddleware: extras.reactShellMiddleware } : {}),
    ...(extras.acpThreadManager !== undefined
      ? { acpThreadManager: extras.acpThreadManager as never }
      : {}),
    log,
  });
  await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', () => resolve()));
  const rig: Rig = {
    port,
    contentDir,
    cleanup: async () => {
      await handler.close();
      await mount.shutdown();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
      rmSync(contentDir, { recursive: true, force: true });
    },
  };
  rigs.push(rig);
  return rig;
}

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Raw request with full Host-header control (fetch forbids overriding Host). */
function raw(
  port: number,
  opts: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: opts.path,
        method: opts.method ?? 'GET',
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

/** Initialize an MCP session through the mount with the given gate headers. */
async function openSession(
  port: number,
  gateHeaders: Record<string, string>,
): Promise<{ sessionId: string }> {
  const init = await raw(port, {
    method: 'POST',
    path: '/mcp',
    headers: {
      ...gateHeaders,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'remote-mcp-test', version: '0.0.0' },
      },
    }),
  });
  expect(init.status).toBe(200);
  const sessionId = init.headers['mcp-session-id'];
  expect(typeof sessionId).toBe('string');
  const initialized = await raw(port, {
    method: 'POST',
    path: '/mcp',
    headers: {
      ...gateHeaders,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-session-id': sessionId as string,
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  expect(initialized.status).toBe(202);
  return { sessionId: sessionId as string };
}

async function listToolNames(port: number, gateHeaders: Record<string, string>): Promise<string[]> {
  const { sessionId } = await openSession(port, gateHeaders);
  const res = await raw(port, {
    method: 'POST',
    path: '/mcp',
    headers: {
      ...gateHeaders,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-session-id': sessionId,
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  });
  expect(res.status).toBe(200);
  const parsed = JSON.parse(res.body) as { result?: { tools?: Array<{ name: string }> } };
  const tools = parsed.result?.tools;
  expect(Array.isArray(tools)).toBe(true);
  return (tools ?? []).map((t) => t.name);
}

const WRITE_TOOLS = [
  'write',
  'edit',
  'delete',
  'move',
  'install',
  'checkpoint',
  'restore_version',
  'resolve_conflict',
];

/** Raw WS upgrade attempt; resolves 'upgraded' on a 101, 'closed' on drop. */
function attemptCollabUpgrade(
  port: number,
  headers: Record<string, string>,
  path = '/collab',
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = createNetConnection({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timed out waiting for /collab upgrade outcome'));
    }, 2000);
    const headerLines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
    socket.on('connect', () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          ...headerLines,
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n'),
      );
    });
    socket.on('data', (chunk: Buffer) => {
      if (chunk.toString('utf8').includes('101 Switching Protocols')) {
        clearTimeout(timer);
        socket.destroy();
        resolve('upgraded');
      }
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve('closed');
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve('closed');
    });
  });
}

// ---------------------------------------------------------------------------

describe('remote enabled — trust-the-tunnel admission', () => {
  test('tunnel-Host /mcp is admitted with the full tool set (no server-side auth tier)', async () => {
    const rig = await bootRemoteRig({ url: PUBLIC_URL });
    const names = await listToolNames(rig.port, TUNNEL_HEADERS);
    expect(names).toContain('exec');
    expect(names).toContain('search');
    for (const tool of WRITE_TOOLS) expect(names).toContain(tool);
  });

  test('local loopback sessions keep the full tool set when remote is enabled', async () => {
    const rig = await bootRemoteRig({ url: PUBLIC_URL });
    const names = await listToolNames(rig.port, { host: `127.0.0.1:${rig.port}` });
    for (const tool of WRITE_TOOLS) expect(names).toContain(tool);
  });

  test('wrong Host is refused everywhere (DNS-rebinding shape)', async () => {
    const rig = await bootRemoteRig({ url: PUBLIC_URL });
    const mcp = await raw(rig.port, {
      method: 'POST',
      path: '/mcp',
      headers: { host: 'evil.example.com' },
    });
    expect(mcp.status).toBe(403);
    const api = await raw(rig.port, { path: '/api/pages', headers: { host: 'evil.example.com' } });
    expect(api.status).toBe(403);
    expect(api.body).toContain('urn:ok:error:host-not-allowed');
  });

  test('non-/mcp surfaces are reachable under the tunnel Host (one gate for everything)', async () => {
    const rig = await bootRemoteRig({ url: PUBLIC_URL });
    // The mocked hocuspocus answers nothing, so the mount's own 404 backstop
    // responding at all (vs a 403) proves admission.
    const api = await raw(rig.port, { path: '/api/pages', headers: TUNNEL_HEADERS });
    expect(api.status).toBe(404);
    const spa = await raw(rig.port, { path: '/', headers: TUNNEL_HEADERS });
    expect(spa.status).toBe(404);
  });

  test('forwarding headers are fine when remote is enabled (tunnels always inject them)', async () => {
    const rig = await bootRemoteRig({ url: PUBLIC_URL });
    const api = await raw(rig.port, { path: '/api/pages', headers: TUNNEL_FORWARDED_HEADERS });
    expect(api.status).toBe(404);
  });

  test('vendor identity/marker headers are inert — admission is Host-only', async () => {
    const rig = await bootRemoteRig({ url: PUBLIC_URL });
    // Pre-R0 these headers switched tiers (tailnet/funnel). Now they must
    // change nothing: same Host, same admission, same tool set.
    const names = await listToolNames(rig.port, {
      host: PUBLIC_HOST,
      'tailscale-funnel-request': '?1',
      'tailscale-user-login': 'someone@example',
    });
    for (const tool of WRITE_TOOLS) expect(names).toContain(tool);
  });

  test('/collab upgrade admits the tunnel Host and drops wrong Hosts', async () => {
    const rig = await bootRemoteRig({ url: PUBLIC_URL });
    await expect(attemptCollabUpgrade(rig.port, { Host: PUBLIC_HOST })).resolves.toBe('upgraded');
    await expect(attemptCollabUpgrade(rig.port, { Host: 'evil.example.com' })).resolves.toBe(
      'closed',
    );
  });

  test('/collab/keepalive upgrade admits the tunnel Host and drops wrong Hosts', async () => {
    const rig = await bootRemoteRig({ url: PUBLIC_URL });
    await expect(
      attemptCollabUpgrade(rig.port, { Host: PUBLIC_HOST }, '/collab/keepalive'),
    ).resolves.toBe('upgraded');
    await expect(
      attemptCollabUpgrade(rig.port, { Host: 'evil.example.com' }, '/collab/keepalive'),
    ).resolves.toBe('closed');
  });

  test('/collab/thread upgrade admits the tunnel Host so Ask AI works over the tunnel', async () => {
    // The stub thread manager only clears the fail-closed `acp == null` guard;
    // the socket touches it solely when a client sends a frame (this raw
    // upgrade never does), so admission is the only thing under test.
    const rig = await bootRemoteRig(
      { url: PUBLIC_URL },
      { acpThreadManager: { listThreads: () => [] } },
    );
    await expect(
      attemptCollabUpgrade(rig.port, { Host: PUBLIC_HOST }, '/collab/thread'),
    ).resolves.toBe('upgraded');
    await expect(
      attemptCollabUpgrade(rig.port, { Host: 'evil.example.com' }, '/collab/thread'),
    ).resolves.toBe('closed');
    // A foreign browser Origin is refused even under the correct tunnel Host.
    await expect(
      attemptCollabUpgrade(
        rig.port,
        { Host: PUBLIC_HOST, Origin: 'https://evil.example.com' },
        '/collab/thread',
      ),
    ).resolves.toBe('closed');
  });

  test('default-port Host suffix still matches', async () => {
    const rig = await bootRemoteRig({ url: PUBLIC_URL });
    const api = await raw(rig.port, {
      path: '/api/pages',
      headers: { host: `${PUBLIC_HOST}:443` },
    });
    expect(api.status).toBe(404);
  });
});

describe('remote disabled — the forwarding-header tripwire', () => {
  test('proxied requests are refused with the --remote hint', async () => {
    const rig = await bootRemoteRig({});
    const res = await raw(rig.port, {
      path: '/api/pages',
      headers: { host: `127.0.0.1:${rig.port}`, 'x-forwarded-for': '203.0.113.7' },
    });
    expect(res.status).toBe(403);
    expect(res.body).toContain('ok start --remote');
  });

  test('vendor proxy headers (X-Real-IP, CF-Connecting-IP, True-Client-IP) also trip the wire', async () => {
    const rig = await bootRemoteRig({});
    for (const header of ['x-real-ip', 'cf-connecting-ip', 'true-client-ip']) {
      const res = await raw(rig.port, {
        path: '/api/pages',
        headers: { host: `127.0.0.1:${rig.port}`, [header]: '203.0.113.7' },
      });
      expect(res.status, `${header} should trip the wire`).toBe(403);
      expect(res.body).toContain('ok start --remote');
    }
  });

  test('unproxied local requests are served as always', async () => {
    const rig = await bootRemoteRig({});
    const api = await raw(rig.port, {
      path: '/api/pages',
      headers: { host: `127.0.0.1:${rig.port}` },
    });
    expect(api.status).toBe(404);
    const names = await listToolNames(rig.port, { host: `127.0.0.1:${rig.port}` });
    for (const tool of WRITE_TOOLS) expect(names).toContain(tool);
  });

  test('a proxied /collab upgrade is dropped', async () => {
    const rig = await bootRemoteRig({});
    await expect(
      attemptCollabUpgrade(rig.port, {
        Host: `127.0.0.1:${rig.port}`,
        'X-Forwarded-For': '203.0.113.7',
      }),
    ).resolves.toBe('closed');
  });

  test('tunnel Host without remote enabled is refused (no forwarding headers needed)', async () => {
    const rig = await bootRemoteRig({});
    const res = await raw(rig.port, {
      method: 'POST',
      path: '/mcp',
      headers: { host: PUBLIC_HOST },
    });
    expect(res.status).toBe(403);
  });
});

describe('remote enabled — UI over the same port', () => {
  const shell = (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    _next: () => void,
  ): void => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`SHELL ${req.url ?? ''}`);
  };

  test('the shell serves at / and /assets/* under the tunnel Host', async () => {
    const rig = await bootRemoteRig({ url: PUBLIC_URL }, { reactShellMiddleware: shell });
    const root = await raw(rig.port, { path: '/', headers: TUNNEL_HEADERS });
    expect(root.status).toBe(200);
    expect(root.body).toContain('SHELL /');
    const asset = await raw(rig.port, { path: '/assets/app.js', headers: TUNNEL_HEADERS });
    expect(asset.status).toBe(200);
    // /mcp stays MCP — the shell never shadows it.
    const mcp = await raw(rig.port, { method: 'POST', path: '/mcp', headers: TUNNEL_HEADERS });
    expect(mcp.body).not.toContain('SHELL');
  });

  test('the shell is refused under a wrong Host', async () => {
    const rig = await bootRemoteRig({ url: PUBLIC_URL }, { reactShellMiddleware: shell });
    const res = await raw(rig.port, { path: '/', headers: { host: 'evil.example.com' } });
    expect(res.status).toBe(403);
  });

  test('a browser Origin from the tunnel host is admitted on /mcp', async () => {
    const rig = await bootRemoteRig({ url: PUBLIC_URL });
    const names = await listToolNames(rig.port, {
      host: PUBLIC_HOST,
      origin: `https://${PUBLIC_HOST}`,
    });
    expect(names).toContain('search');
  });

  test('a foreign browser Origin is still refused on /mcp', async () => {
    const rig = await bootRemoteRig({ url: PUBLIC_URL });
    const res = await raw(rig.port, {
      method: 'POST',
      path: '/mcp',
      headers: { host: PUBLIC_HOST, origin: 'https://evil.example.com' },
    });
    expect(res.status).toBe(403);
  });
});
