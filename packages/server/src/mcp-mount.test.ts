import { afterEach, describe, expect, test } from 'bun:test';
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
import { WebSocket } from 'ws';
import { createAssetServeMiddleware } from './asset-serve-middleware.ts';
import { getFreeLoopbackPort } from './loopback-rig-test-helpers.ts';
import type { McpHttpHandler } from './mcp-http.ts';
import {
  type MountMcpAndApiHandle,
  type MountMcpAndApiOptions,
  mountMcpAndApi,
} from './mcp-mount.ts';

const log = {
  error: () => {},
  warn: () => {},
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

async function startMountedServer(handler: McpHttpHandler): Promise<{ port: number }> {
  const httpServer = createServer();
  const mount = mountMcpAndApi({
    httpServer,
    hocuspocus,
    mcpHttpHandler: handler,
    log,
  });
  const port = await getFreeLoopbackPort();
  await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', () => resolve()));
  servers.push({ httpServer, mount });
  return { port };
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

/** GET `path` with an explicit `Host` header — `fetch` can't override Host, so
 *  the rebinding case (loopback TCP peer, attacker-controlled Host) needs the
 *  raw `http.request`. */
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

async function requestUnknownUpgrade(port: number): Promise<string> {
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
          'GET /not-a-websocket-route HTTP/1.1',
          'Host: 127.0.0.1',
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
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
});

// Regression: a live `/collab` or `/collab/keepalive` WS that survives into
// teardown must not stall the caller's close steps. An upgraded WS socket is
// detached from the HTTP server, so `httpServer.close()` won't return — and
// `wss.close()` won't complete — while it's still open. `mount.shutdown()` must
// drain the live upgrade sockets directly (`httpServer.closeAllConnections()`
// is unreliable for upgrade-detached sockets across runtimes) so both close
// steps resolve promptly instead of blocking until the boot path's per-step
// timeout fires. Deliberately does NOT call `closeAllConnections()` between the
// close steps — the drain must stand on its own, matching the worst-case
// packaged-build runtime where that backstop is a no-op.
describe('mountMcpAndApi shutdown drains live WS clients', () => {
  for (const path of ['/collab', '/collab/keepalive?connectionId=teardown-probe']) {
    test(`drains live ${path.split('?')[0]} WS so wss.close + httpServer.close resolve promptly`, async () => {
      const httpServer = createServer();
      const mount = mountMcpAndApi({ httpServer, hocuspocus, log });
      const port = await getFreeLoopbackPort();
      await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', () => resolve()));

      const client = new WebSocket(`ws://127.0.0.1:${port}${path}`);
      // Keep an error sink attached for the lifetime of the socket — the server
      // destroys it during teardown, which surfaces a 1006 abnormal-closure
      // error on the client that would otherwise go unhandled.
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

        // Race against a budget far below the boot path's per-step timeout
        // (DESTROY_STEP_TIMEOUT_MS = 5000). the close steps never call
        // back while the socket is open, so the race would time out.
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

// Desktop mode wires a `contentAssetMiddleware` (the canonical
// `createAssetServeMiddleware`) so the utility server's origin serves
// content assets — the Electron renderer page origin has none. This
// exercises the wiring against a real sirv over a tmpdir + a stub filter.
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
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic
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
    // Exists on disk — but the filter excludes it, so the middleware must
    // call next() (it never reaches sirv).
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
    // The middleware (not the catch-all errorResponse) handled it: it set the
    // nosniff header before sirv fell through, and the body is empty rather
    // than the problem+json envelope.
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-type')).not.toBe('application/problem+json');
    expect(await res.text()).toBe('');
  });

  test('synchronous throw from middleware returns a 500 problem+json (no hang)', async () => {
    // Real-world trigger: sirv's `viaLocal` calls `fs.existsSync` /
    // `fs.statSync` synchronously — under FD exhaustion (`EMFILE`/`ENFILE`)
    // those throw. Without the try/catch in `mountMcpAndApi`, the throw
    // propagates to http.Server's 'request' listener and the response
    // hangs until `requestTimeout`. We simulate the throw with a stub
    // middleware (the real ENFILE failure mode is hard to provoke
    // reliably) — the assertion is that mountMcpAndApi terminates the
    // response cleanly with a 500 envelope rather than hanging.
    const httpServer = createServer();
    const mount = mountMcpAndApi({
      httpServer,
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

// Ephemeral single-file mode (`ok <file>`) points contentDir at the opened
// file's parent — often a user-data dir. The content-asset surface must carry
// the same loopback + workspace-host gate the `/mcp` leg uses so a DNS-rebound
// or non-loopback caller can't read that dir. Project / desktop modes
// (`ephemeral` unset) keep serving assets unchanged.
describe('mountMcpAndApi ephemeral content-asset gate', () => {
  const tmpDirs: string[] = [];

  async function startAssets(ephemeral: boolean): Promise<{ port: number }> {
    const contentDir = mkdtempSync(join(tmpdir(), 'ok-mcp-mount-gate-'));
    tmpDirs.push(contentDir);
    // PNG magic — a real asset the middleware will serve inline.
    writeFileSync(
      join(contentDir, 'secret.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const httpServer = createServer();
    const mount = mountMcpAndApi({
      httpServer,
      hocuspocus,
      log,
      ephemeral,
      contentAssetMiddleware: createAssetServeMiddleware({
        contentFilter: { isPathIgnored: () => false },
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

  test('ephemeral: a loopback request with a localhost Host still serves the asset', async () => {
    const { port } = await startAssets(true);
    const res = await getWithHost(port, '/secret.png', `localhost:${port}`);
    expect(res.status).toBe(200);
  });

  test('ephemeral: a rebound Host header is rejected with 403 loopback-required', async () => {
    const { port } = await startAssets(true);
    // Loopback TCP peer (127.0.0.1) but an attacker-controlled Host — the
    // DNS-rebinding shape. The Host gate rejects it before sirv reads the file.
    const res = await getWithHost(port, '/secret.png', 'evil.example.com');
    expect(res.status).toBe(403);
    expect((JSON.parse(res.body) as { type?: string }).type).toBe('urn:ok:error:loopback-required');
  });

  test('non-ephemeral (project mode): the same rebound Host header still serves', async () => {
    // Proves the gate is ephemeral-scoped — project / desktop asset serving is
    // untouched, so this is not a regression to the existing flow.
    const { port } = await startAssets(false);
    const res = await getWithHost(port, '/secret.png', 'evil.example.com');
    expect(res.status).toBe(200);
  });

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
});

// React-shell middleware — opt-in via `reactShellDistDir` in bootServer;
// passed through to mountMcpAndApi as `reactShellMiddleware`. Mounted as
// the final fallback after contentAssetMiddleware so existing surfaces
// keep priority and the SPA shell only catches non-data routes.
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
    // A bundled binary asset whose extension IS in ASSET_EXTENSIONS — the
    // class that regressed (the content middleware fail-closes 404 on these
    // when the content dir misses, so shell-first routing is what makes them
    // serve). `.js` above is NOT an asset extension and never hit the
    // fail-close, so it can't guard the fix.
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
    // Regression guard for the original bug: `.woff2` IS in ASSET_EXTENSIONS,
    // so a content-first dispatcher fail-closes (404 without next()) on a
    // content-dir miss before the shell — which holds the font — is tried.
    // Wire a REAL content middleware over an empty content dir so the
    // fail-close path is exercised; the `/assets/`-first branch must serve the
    // bundled font from the shell anyway. (`.js`-only coverage above can't
    // catch this — js isn't an asset extension.)
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
    // single: true makes sirv serve index.html for unknown non-file routes.
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('data-test="shell"');
  });

  test('does NOT shadow /api/* or /mcp routes', async () => {
    const { port } = await startWithShell();
    // /api/missing is not registered → catch-all 404 problem+json.
    // The react-shell middleware MUST NOT serve index.html here because
    // /api/* requests are handled before the shell middleware is reached.
    const res = await fetch(`http://127.0.0.1:${port}/api/nonexistent-endpoint`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
  });

  test('user upload under /assets/ with no shell match falls through to the content middleware', async () => {
    // `/assets/*` is shell-first, but the shell has no `user-upload.png`, so it
    // must fall through to the content middleware and serve the upload. This is
    // how doc-referenced media at `<contentDir>/assets/...` keeps serving after
    // the shell-first reorder. (NOT a content-priority assertion.)
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
    // The one genuine semantic change from shell-first routing: when the same
    // `/assets/<name>` exists in BOTH the shell dist and the content dir, the
    // shell copy now wins (it was content-first before). Practically harmless —
    // SPA bundle names are content-hashed — but pin it so the priority flip is
    // an explicit, intentional contract rather than an accident.
    const contentDir = mkdtempSync(join(tmpdir(), 'ok-mcp-mount-shell-collision-'));
    tmpDirs.push(contentDir);
    mkdirSync(join(contentDir, 'assets'));
    const contentBytes = Buffer.from('content-copy-distinct-bytes', 'utf-8');
    // Same basename as the shell's bundled font fixture (see makeShellDir).
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
    // Build a content-asset middleware over an empty content dir.
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

    // A non-asset URL the content middleware doesn't recognize falls through
    // to the react-shell SPA fallback (single: true → index.html).
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
