import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server as HttpServer, request as httpRequest } from 'node:http';
import { connect as createNetConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hocuspocus } from '@hocuspocus/server';
import {
  ASSET_EXTENSIONS,
  EXECUTABLE_BLOCKLIST_EXTENSIONS,
  INLINE_RENDERABLE_EXTENSIONS,
} from '@inkeep/open-knowledge-core';
import sirv from 'sirv';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createAssetServeMiddleware } from './asset-serve-middleware.ts';
import {
  __resetWarnedForwardedHeaderRefusalForTests,
  buildIngressPolicy,
} from './ingress-policy.ts';
import { getFreeLoopbackPort } from './loopback-rig-test-helpers.ts';
import type { McpHttpHandler } from './mcp-http.ts';
import {
  type MountMcpAndApiHandle,
  type MountMcpAndApiOptions,
  mountMcpAndApi,
} from './mcp-mount.ts';

const log = {
  error: () => {},
  warn: vi.fn(),
  info: () => {},
  debug: () => {},
  child: () => log,
} as never;

const hocuspocus = {
  hooks: async () => {},
  handleConnection: () => ({
    handleMessage: () => {},
    handleClose: () => {},
  }),
} as unknown as Hocuspocus;

let servers: Array<{ httpServer: HttpServer; mount: MountMcpAndApiHandle }> = [];

async function startMountedServer(
  handler: McpHttpHandler,
  serverHocuspocus: Hocuspocus = hocuspocus,
): Promise<{ port: number; mount: MountMcpAndApiHandle }> {
  const httpServer = createServer();
  const mount = mountMcpAndApi({
    httpServer,
    nativeApi: undefined,
    hocuspocus: serverHocuspocus,
    mcpHttpHandler: handler,
    log,
  });
  const port = await getFreeLoopbackPort();
  await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', () => resolve()));
  servers.push({ httpServer, mount });
  return { port, mount };
}

async function postMcpWithHost(
  port: number,
  host: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: { Host: host, 'Content-Type': 'application/json' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end('{}');
  });
}

async function getWithHost(
  port: number,
  path: string,
  host: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers: { Host: host } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function requestUnknownUpgrade(port: number, forwarding = false): Promise<string> {
  return requestUpgrade(port, '/not-a-websocket-route', forwarding);
}

async function requestUpgrade(port: number, path: string, forwarding = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createNetConnection({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timed out waiting for unknown upgrade socket to close'));
    }, 1000);

    socket.on('connect', () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          'Host: 127.0.0.1',
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          ...(forwarding ? ['X-Forwarded-For: 203.0.113.7'] : []),
          '',
          '',
        ].join('\r\n'),
      );
    });
    socket.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
  });
}

async function requestRejectedUpgrade(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });
    req.on('response', (res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      res.on('end', () => resolve(status));
    });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      reject(new Error('upgrade was admitted after shutdown'));
    });
    req.on('error', reject);
    req.setTimeout(1_000, () => req.destroy(new Error('timed out waiting for upgrade refusal')));
    req.end();
  });
}

afterEach(async () => {
  const active = servers;
  servers = [];
  await Promise.allSettled(
    active.map(async ({ httpServer, mount }) => {
      await mount.shutdown();
      await new Promise<void>((resolve) => mount.wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }),
  );
});

beforeEach(() => {
  __resetWarnedForwardedHeaderRefusalForTests();
});

describe('mountMcpAndApi /mcp guard', () => {
  test('rejects non-loopback Origin before the MCP handler runs', async () => {
    let calls = 0;
    const { port } = await startMountedServer({
      handle: async (_req, res) => {
        calls += 1;
        res.writeHead(200);
        res.end('ok');
      },
      close: async () => {},
    });

    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = (await res.json()) as { type?: string; title?: string; status?: number };
    expect(body.type).toBe('urn:ok:error:invalid-origin');
    expect(body.title).toBe('Origin not allowed.');
    expect(body.status).toBe(403);
    expect(calls).toBe(0);
  });

  test('rejects non-loopback Host before the MCP handler runs', async () => {
    let calls = 0;
    const { port } = await startMountedServer({
      handle: async (_req, res) => {
        calls += 1;
        res.writeHead(200);
        res.end('ok');
      },
      close: async () => {},
    });

    const res = await postMcpWithHost(port, 'evil.example');

    expect(res.status).toBe(403);
    const body = JSON.parse(res.body) as { type?: string; title?: string; status?: number };
    expect(body.type).toBe('urn:ok:error:host-not-allowed');
    expect(body.title).toBe('Host header not allowed.');
    expect(body.status).toBe(403);
    expect(calls).toBe(0);
  });

  test('answers allowed-origin MCP preflight with MCP headers', async () => {
    let calls = 0;
    const { port } = await startMountedServer({
      handle: async (_req, res) => {
        calls += 1;
        res.writeHead(200);
        res.end('ok');
      },
      close: async () => {},
    });

    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173' },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(res.headers.get('access-control-allow-headers')).toContain('mcp-session-id');
    expect(calls).toBe(0);
  });

  test('closes unrecognized WebSocket upgrade paths', async () => {
    let calls = 0;
    const { port } = await startMountedServer({
      handle: async (_req, res) => {
        calls += 1;
        res.writeHead(200);
        res.end('ok');
      },
      close: async () => {},
    });

    const response = await requestUnknownUpgrade(port);

    expect(response).toBe('');
    expect(calls).toBe(0);
  });

  test('warns before closing a proxied unknown upgrade', async () => {
    vi.mocked(log.warn).mockClear();
    const { port } = await startMountedServer({ handle: async () => {}, close: async () => {} });

    await expect(requestUnknownUpgrade(port, true)).resolves.toBe('');
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ host: '127.0.0.1' }),
      expect.stringContaining('refused proxied WS upgrade'),
    );
    expect(log.warn).toHaveBeenCalledWith(
      { handler: 'ws-upgrade' },
      expect.stringContaining('server.allowExternal'),
    );
  });

  test('shares shutdown and keeps routing attached until the server closes', async () => {
    const handleConnection = vi.fn(() => ({
      handleMessage: () => {},
      handleClose: () => {},
    }));
    const scopedHocuspocus = {
      hooks: async () => {},
      handleConnection,
    } as unknown as Hocuspocus;
    const { port, mount } = await startMountedServer(
      {
        handle: async () => {},
        close: async () => {},
      },
      scopedHocuspocus,
    );
    const first = mount.shutdown();
    expect(mount.shutdown()).toBe(first);
    await first;

    const response = await fetch(`http://127.0.0.1:${port}/still-routed`, {
      signal: AbortSignal.timeout(1_000),
    });
    expect(response.status).toBe(404);

    await expect(requestRejectedUpgrade(port, '/collab')).resolves.toBe(404);
    expect(handleConnection).not.toHaveBeenCalled();
    expect(mount.wss.clients.size).toBe(0);
  });
});

describe('mountMcpAndApi shutdown drains live WS clients', () => {
  for (const path of ['/collab', '/collab/keepalive?connectionId=teardown-probe']) {
    test(`drains live ${path.split('?')[0]} WS so wss.close + httpServer.close resolve promptly`, async () => {
      const httpServer = createServer();
      const mount = mountMcpAndApi({ httpServer, nativeApi: undefined, hocuspocus, log });
      const port = await getFreeLoopbackPort();
      await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', () => resolve()));

      const client = new WebSocket(`ws://127.0.0.1:${port}${path}`);
      client.on('error', () => {});
      try {
        await new Promise<void>((resolve, reject) => {
          client.once('open', () => resolve());
          client.once('error', reject);
        });
        expect(mount.wss.clients.size).toBe(1);

        const teardown = (async (): Promise<'done'> => {
          await mount.shutdown();
          await new Promise<void>((resolve, reject) =>
            mount.wss.close((err) => (err ? reject(err) : resolve())),
          );
          await new Promise<void>((resolve, reject) =>
            httpServer.close((err) =>
              err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
                ? reject(err)
                : resolve(),
            ),
          );
          return 'done';
        })();

        let budgetTimer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          teardown,
          new Promise<'timeout'>((resolve) => {
            budgetTimer = setTimeout(() => resolve('timeout'), 2000);
          }),
        ]);
        if (budgetTimer !== undefined) clearTimeout(budgetTimer);

        expect(result).toBe('done');
        expect(mount.wss.clients.size).toBe(0);
      } finally {
        client.terminate();
        httpServer.closeAllConnections?.();
      }
    });
  }
});

describe('mountMcpAndApi content-asset middleware', () => {
  const tmpDirs: string[] = [];

  function makeContentDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ok-mcp-mount-assets-'));
    tmpDirs.push(dir);
    return dir;
  }

  async function startWithAssets(contentDir: string): Promise<{ port: number }> {
    const httpServer = createServer();
    const filter = {
      isPathIgnored: (rel: string) => rel.startsWith('.ok/') || rel === 'excluded.png',
    };
    const mount = mountMcpAndApi({
      httpServer,
      nativeApi: undefined,
      hocuspocus,
      log,
      contentAssetMiddleware: createAssetServeMiddleware({
        contentFilter: filter,
        contentSirv: sirv(contentDir, { dev: true, dotfiles: false }),
        inlineExtensions: INLINE_RENDERABLE_EXTENSIONS,
        assetExtensions: ASSET_EXTENSIONS,
        blocklistExtensions: EXECUTABLE_BLOCKLIST_EXTENSIONS,
      }),
    });
    const port = await getFreeLoopbackPort();
    await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', () => resolve()));
    servers.push({ httpServer, mount });
    return { port };
  }

  test('serves a content asset with inline disposition + nosniff', async () => {
    const contentDir = makeContentDir();
    mkdirSync(join(contentDir, 'assets'));
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeFileSync(join(contentDir, 'assets', 'x.png'), bytes);
    const { port } = await startWithAssets(contentDir);

    const res = await fetch(`http://127.0.0.1:${port}/assets/x.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('inline');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const got = Buffer.from(await res.arrayBuffer());
    expect(got.equals(bytes)).toBe(true);
  });

  test('content-filter-excluded path falls through to the problem+json 404', async () => {
    const contentDir = makeContentDir();
    mkdirSync(join(contentDir, 'assets'));
    writeFileSync(join(contentDir, 'excluded.png'), Buffer.from([0]));
    const { port } = await startWithAssets(contentDir);

    const res = await fetch(`http://127.0.0.1:${port}/excluded.png`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = (await res.json()) as { type?: string };
    expect(body.type).toBe('urn:ok:error:not-found');
  });

  test('asset-extension miss returns a bare 404 from the middleware, not the catch-all', async () => {
    const contentDir = makeContentDir();
    const { port } = await startWithAssets(contentDir);

    const res = await fetch(`http://127.0.0.1:${port}/missing.png`);
    expect(res.status).toBe(404);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-type')).not.toBe('application/problem+json');
    expect(await res.text()).toBe('');
  });

  test('synchronous throw from middleware returns a 500 problem+json (no hang)', async () => {
    const httpServer = createServer();
    const mount = mountMcpAndApi({
      httpServer,
      nativeApi: undefined,
      hocuspocus,
      log,
      contentAssetMiddleware: () => {
        throw new Error('simulated EMFILE');
      },
    });
    const port = await getFreeLoopbackPort();
    await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', () => resolve()));
    servers.push({ httpServer, mount });

    const res = await fetch(`http://127.0.0.1:${port}/assets/x.png`);
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = (await res.json()) as { type?: string; status?: number };
    expect(body.type).toBe('urn:ok:error:internal-server-error');
    expect(body.status).toBe(500);
  });

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('mountMcpAndApi ephemeral content-asset gate', () => {
  const tmpDirs: string[] = [];

  async function startAssets(ephemeral: boolean): Promise<{ port: number }> {
    const contentDir = mkdtempSync(join(tmpdir(), 'ok-mcp-mount-gate-'));
    tmpDirs.push(contentDir);
    writeFileSync(
      join(contentDir, 'secret.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const httpServer = createServer();
    const mount = mountMcpAndApi({
      httpServer,
      nativeApi: undefined,
      hocuspocus,
      log,
      ephemeral,
      contentAssetMiddleware: createAssetServeMiddleware({
        contentFilter: { isPathIgnored: () => false },
        contentSirv: sirv(contentDir, { dev: true, dotfiles: false }),
        inlineExtensions: INLINE_RENDERABLE_EXTENSIONS,
        assetExtensions: ASSET_EXTENSIONS,
        blocklistExtensions: EXECUTABLE_BLOCKLIST_EXTENSIONS,
        ingressPolicy: buildIngressPolicy({}),
      }),
    });
    const port = await getFreeLoopbackPort();
    await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', () => resolve()));
    servers.push({ httpServer, mount });
    return { port };
  }

  test('ephemeral: a loopback request with a localhost Host still serves the asset', async () => {
    const { port } = await startAssets(true);
    const res = await getWithHost(port, '/secret.png', `localhost:${port}`);
    expect(res.status).toBe(200);
  });

  test('ephemeral: a rebound Host header is rejected with 403 host-not-allowed', async () => {
    const { port } = await startAssets(true);
    const res = await getWithHost(port, '/secret.png', 'evil.example.com');
    expect(res.status).toBe(403);
    expect((JSON.parse(res.body) as { type?: string }).type).toBe('urn:ok:error:host-not-allowed');
  });

  test('non-ephemeral (project mode): a rebound Host is refused by the content-serve gate', async () => {
    const { port } = await startAssets(false);
    const res = await getWithHost(port, '/secret.png', 'evil.example.com');
    expect(res.status).toBe(403);
    expect((JSON.parse(res.body) as { type?: string }).type).toBe('urn:ok:error:host-not-allowed');
  });

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
});

describe('mountMcpAndApi react-shell middleware', () => {
  const tmpDirs: string[] = [];
  const SHELL_FONT_BYTES = Buffer.from('woff2-bundle-bytes', 'utf-8');

  function makeShellDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ok-mcp-mount-shell-'));
    tmpDirs.push(dir);
    writeFileSync(
      join(dir, 'index.html'),
      '<!DOCTYPE html><html><body data-test="shell">ok</body></html>',
    );
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log("bundle");');
    writeFileSync(join(dir, 'assets', 'inter-cafebabe.woff2'), SHELL_FONT_BYTES);
    return dir;
  }

  async function startWithShell(opts?: {
    contentAssetMiddleware?: MountMcpAndApiOptions['contentAssetMiddleware'];
  }): Promise<{ port: number; shellDir: string }> {
    const shellDir = makeShellDir();
    const httpServer = createServer();
    const mount = mountMcpAndApi({
      httpServer,
      nativeApi: undefined,
      hocuspocus,
      log,
      contentAssetMiddleware: opts?.contentAssetMiddleware,
      reactShellMiddleware: sirv(shellDir, {
        single: true,
        gzip: true,
        immutable: true,
      }),
    });
    const port = await getFreeLoopbackPort();
    await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', () => resolve()));
    servers.push({ httpServer, mount });
    return { port, shellDir };
  }

  test('serves index.html on root request (SPA shell entry)', async () => {
    const { port } = await startWithShell();
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('data-test="shell"');
  });

  test('serves a bundled asset under /assets/<hash>.js', async () => {
    const { port } = await startWithShell();
    const res = await fetch(`http://127.0.0.1:${port}/assets/app-abc123.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('console.log');
  });

  test('serves a bundled binary asset (/assets/<hash>.woff2) when the content middleware would fail-close', async () => {
    const contentDir = mkdtempSync(join(tmpdir(), 'ok-mcp-mount-shell-woff2-'));
    tmpDirs.push(contentDir);
    const filter = { isPathIgnored: () => false };
    const contentAssetMiddleware = createAssetServeMiddleware({
      contentFilter: filter,
      contentSirv: sirv(contentDir, { dev: true, dotfiles: false }),
      inlineExtensions: INLINE_RENDERABLE_EXTENSIONS,
      assetExtensions: ASSET_EXTENSIONS,
      blocklistExtensions: EXECUTABLE_BLOCKLIST_EXTENSIONS,
    });
    const { port } = await startWithShell({ contentAssetMiddleware });

    const res = await fetch(`http://127.0.0.1:${port}/assets/inter-cafebabe.woff2`);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(SHELL_FONT_BYTES)).toBe(true);
  });

  test('SPA fallback: unknown deep-link route returns index.html (single: true)', async () => {
    const { port } = await startWithShell();
    const res = await fetch(`http://127.0.0.1:${port}/some/deep/route`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('data-test="shell"');
  });

  test('does NOT shadow /api/* or /mcp routes', async () => {
    const { port } = await startWithShell();
    const res = await fetch(`http://127.0.0.1:${port}/api/nonexistent-endpoint`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
  });

  test('user upload under /assets/ with no shell match falls through to the content middleware', async () => {
    const contentDir = mkdtempSync(join(tmpdir(), 'ok-mcp-mount-shell-content-'));
    tmpDirs.push(contentDir);
    mkdirSync(join(contentDir, 'assets'));
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeFileSync(join(contentDir, 'assets', 'user-upload.png'), bytes);
    const filter = { isPathIgnored: () => false };
    const contentAssetMiddleware = createAssetServeMiddleware({
      contentFilter: filter,
      contentSirv: sirv(contentDir, { dev: true, dotfiles: false }),
      inlineExtensions: INLINE_RENDERABLE_EXTENSIONS,
      assetExtensions: ASSET_EXTENSIONS,
      blocklistExtensions: EXECUTABLE_BLOCKLIST_EXTENSIONS,
    });
    const { port } = await startWithShell({ contentAssetMiddleware });

    const res = await fetch(`http://127.0.0.1:${port}/assets/user-upload.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('inline');
    const got = Buffer.from(await res.arrayBuffer());
    expect(got.equals(bytes)).toBe(true);
  });

  test('on a /assets/ name collision the SPA shell wins over the content copy', async () => {
    const contentDir = mkdtempSync(join(tmpdir(), 'ok-mcp-mount-shell-collision-'));
    tmpDirs.push(contentDir);
    mkdirSync(join(contentDir, 'assets'));
    const contentBytes = Buffer.from('content-copy-distinct-bytes', 'utf-8');
    writeFileSync(join(contentDir, 'assets', 'inter-cafebabe.woff2'), contentBytes);
    const filter = { isPathIgnored: () => false };
    const contentAssetMiddleware = createAssetServeMiddleware({
      contentFilter: filter,
      contentSirv: sirv(contentDir, { dev: true, dotfiles: false }),
      inlineExtensions: INLINE_RENDERABLE_EXTENSIONS,
      assetExtensions: ASSET_EXTENSIONS,
      blocklistExtensions: EXECUTABLE_BLOCKLIST_EXTENSIONS,
    });
    const { port } = await startWithShell({ contentAssetMiddleware });

    const res = await fetch(`http://127.0.0.1:${port}/assets/inter-cafebabe.woff2`);
    expect(res.status).toBe(200);
    const got = Buffer.from(await res.arrayBuffer());
    expect(got.equals(SHELL_FONT_BYTES)).toBe(true);
    expect(got.equals(contentBytes)).toBe(false);
  });

  test('content-miss falls through to react-shell SPA fallback', async () => {
    const contentDir = mkdtempSync(join(tmpdir(), 'ok-mcp-mount-shell-empty-'));
    tmpDirs.push(contentDir);
    const filter = { isPathIgnored: () => false };
    const contentAssetMiddleware = createAssetServeMiddleware({
      contentFilter: filter,
      contentSirv: sirv(contentDir, { dev: true, dotfiles: false }),
      inlineExtensions: INLINE_RENDERABLE_EXTENSIONS,
      assetExtensions: ASSET_EXTENSIONS,
      blocklistExtensions: EXECUTABLE_BLOCKLIST_EXTENSIONS,
    });
    const { port } = await startWithShell({ contentAssetMiddleware });

    const res = await fetch(`http://127.0.0.1:${port}/docs/some-page`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('data-test="shell"');
  });

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
