import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
} from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ProblemDetailsSchema, type Scheduler } from '@inkeep/open-knowledge-core';
import {
  acquireServerLock,
  armPaneTarget,
  ConfigSchema,
  getLocalDir,
  readArmedPaneTarget,
  readUiLock,
  type UiLockMetadata,
  updateServerLockPort,
} from '@inkeep/open-knowledge-server';
import {
  closeHttpServers,
  DEFAULT_UI_PORT,
  DEFAULT_UI_SAFETY_NET_MS,
  isNonInteractiveContext,
  resolveRequestedPort,
  resolveUiLockCollision,
  startUiServer,
  type UiServerHandle,
} from './ui.ts';

interface ManualScheduler extends Scheduler {
  advanceTime(ms: number): void;
  pendingCount(): number;
}

function createManualScheduler(): ManualScheduler {
  type Entry = { id: number; cb: () => void; dueAt: number };
  const queue: Entry[] = [];
  let now = 0;
  let nextId = 1;
  return {
    setTimeout: (cb, ms) => {
      const id = nextId++;
      queue.push({ id, cb, dueAt: now + ms });
      return id as unknown as ReturnType<typeof globalThis.setTimeout>;
    },
    clearTimeout: (handle) => {
      const id = handle as unknown as number;
      const idx = queue.findIndex((e) => e.id === id);
      if (idx >= 0) queue.splice(idx, 1);
    },
    now: () => now,
    advanceTime(ms) {
      now += ms;
      for (let pass = 0; pass < 100; pass++) {
        const due = queue.filter((e) => e.dueAt <= now);
        if (due.length === 0) return;
        for (const e of due) {
          const idx = queue.indexOf(e);
          if (idx >= 0) queue.splice(idx, 1);
          e.cb();
        }
      }
    },
    pendingCount: () => queue.length,
  };
}

let tmpDir: string;
let lockDir: string;
let handle: UiServerHandle | null = null;

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-ui-cmd-test-'));
  lockDir = getLocalDir(tmpDir);
});

afterEach(async () => {
  if (handle) {
    handle.release();
    await closeHttpServers(handle.httpServers);
    handle = null;
  }
  await rm(tmpDir, { recursive: true, force: true });
});

function config() {
  return ConfigSchema.parse({});
}

async function get(port: number, path: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await res.text();
  return { status: res.status, body, headers: res.headers };
}

function seedDist(dir: string, hash: string): string {
  const dist = resolve(dir, 'dist');
  mkdirSync(resolve(dist, 'assets'), { recursive: true });
  writeFileSync(
    resolve(dist, 'index.html'),
    `<!doctype html><html><head><script type="module" src="/assets/app-${hash}.js"></script></head><body><div id="root"></div></body></html>`,
  );
  writeFileSync(resolve(dist, 'assets', `app-${hash}.js`), `console.log(${JSON.stringify(hash)});`);
  return dist;
}

async function rawRequest(opts: {
  port: number;
  path: string;
  method?: string;
  host?: string;
  origin?: string;
  body?: string;
  contentType?: string;
}): Promise<{ status: number; body: string; headers: Record<string, string | string[]> }> {
  return new Promise((done, fail) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: opts.port,
        path: opts.path,
        method: opts.method ?? 'GET',
        headers: {
          host: opts.host ?? `127.0.0.1:${opts.port}`,
          ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
          ...(opts.contentType ? { 'content-type': opts.contentType } : {}),
          ...(opts.body !== undefined
            ? { 'content-length': String(Buffer.byteLength(opts.body)) }
            : {}),
        },
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          done({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
            headers: res.headers as Record<string, string | string[]>,
          });
        });
      },
    );
    req.on('error', fail);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

type UpstreamSurrogate = { port: number; close: () => Promise<void> };

async function startDualLoopbackUpstream(
  handler: Parameters<typeof createHttpServer>[1],
): Promise<UpstreamSurrogate> {
  const v6 = createHttpServer(handler);
  await new Promise<void>((done, fail) => {
    v6.once('error', fail);
    v6.listen(0, '::1', () => {
      v6.off('error', fail);
      done();
    });
  });
  const port = (v6.address() as { port: number }).port;
  const v4 = createHttpServer(handler);
  try {
    await new Promise<void>((done, fail) => {
      v4.once('error', fail);
      v4.listen(port, '127.0.0.1', () => {
        v4.off('error', fail);
        done();
      });
    });
  } catch (err) {
    await new Promise<void>((r) => v6.close(() => r()));
    throw err;
  }
  return {
    port,
    close: async () => {
      await Promise.all([
        new Promise<void>((r) => v6.close(() => r())),
        new Promise<void>((r) => v4.close(() => r())),
      ]);
    },
  };
}

describe('resolveRequestedPort', () => {
  test('default is DEFAULT_UI_PORT with kernel-allocated fallback', () => {
    expect(resolveRequestedPort(undefined, undefined)).toEqual({
      port: DEFAULT_UI_PORT,
      fallbackToKernel: true,
    });
  });
  test('--port wins over PORT env and is operator-explicit (no fallback)', () => {
    expect(resolveRequestedPort('4000', '5000')).toEqual({
      port: 4000,
      fallbackToKernel: false,
    });
  });
  test('PORT env used when --port absent and is operator-explicit (no fallback)', () => {
    expect(resolveRequestedPort(undefined, '5555')).toEqual({
      port: 5555,
      fallbackToKernel: false,
    });
  });
  test('empty PORT env falls back to DEFAULT_UI_PORT with kernel-allocated fallback', () => {
    expect(resolveRequestedPort(undefined, '')).toEqual({
      port: DEFAULT_UI_PORT,
      fallbackToKernel: true,
    });
  });
  test('invalid --port throws', () => {
    expect(() => resolveRequestedPort('nope', undefined)).toThrow();
  });
  test('invalid PORT env throws', () => {
    expect(() => resolveRequestedPort(undefined, 'nope')).toThrow();
  });
  test('port=0 (kernel-allocated) is accepted; explicit caller, no auto-fallback', () => {
    expect(resolveRequestedPort('0', undefined)).toEqual({
      port: 0,
      fallbackToKernel: false,
    });
  });
});

describe('startUiServer', () => {
  test('binds requested port and writes ui.lock with resolved port', async () => {
    handle = await startUiServer({ config: config(), cwd: tmpDir, port: 0, host: '127.0.0.1' });
    expect(handle.port).toBeGreaterThan(0);

    const lockPath = resolve(lockDir, 'ui.lock');
    expect(existsSync(lockPath)).toBe(true);
    const lock = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(lock.pid).toBe(process.pid);
    expect(lock.port).toBe(handle.port);
  });

  test('falls back to kernel-allocation when requested port is busy and fallbackToKernel=true', async () => {
    const { createServer } = await import('node:http');
    const blocker = createServer(() => {});
    await new Promise<void>((done, fail) => {
      blocker.once('error', fail);
      blocker.listen(0, '127.0.0.1', () => done());
    });
    const blockedPort = (blocker.address() as { port: number }).port;
    try {
      handle = await startUiServer({
        config: config(),
        cwd: tmpDir,
        port: blockedPort,
        fallbackToKernel: true,
        host: '127.0.0.1',
      });
      expect(handle.port).toBeGreaterThan(0);
      expect(handle.port).not.toBe(blockedPort);
      const lock = JSON.parse(readFileSync(resolve(lockDir, 'ui.lock'), 'utf-8'));
      expect(lock.port).toBe(handle.port);
    } finally {
      await new Promise<void>((done) => blocker.close(() => done()));
    }
  });

  test('propagates EADDRINUSE when requested port is busy and fallbackToKernel is falsy', async () => {
    const { createServer } = await import('node:http');
    const blocker = createServer(() => {});
    await new Promise<void>((done, fail) => {
      blocker.once('error', fail);
      blocker.listen(0, '127.0.0.1', () => done());
    });
    const blockedPort = (blocker.address() as { port: number }).port;
    try {
      await expect(
        startUiServer({
          config: config(),
          cwd: tmpDir,
          port: blockedPort,
          host: '127.0.0.1',
        }),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await new Promise<void>((done) => blocker.close(() => done()));
    }
  });

  test('two-socket loopback default: IPv6 binds then IPv4 EADDRINUSE triggers full retry', async () => {
    const { createServer } = await import('node:http');
    const blocker = createServer(() => {});
    await new Promise<void>((done, fail) => {
      blocker.once('error', fail);
      blocker.listen(0, '127.0.0.1', () => done());
    });
    const blockedPort = (blocker.address() as { port: number }).port;
    try {
      handle = await startUiServer({
        config: config(),
        cwd: tmpDir,
        port: blockedPort,
        fallbackToKernel: true,
      });
      expect(handle.port).toBeGreaterThan(0);
      expect(handle.port).not.toBe(blockedPort);
      expect(handle.httpServers).toHaveLength(2);
      const lock = JSON.parse(readFileSync(resolve(lockDir, 'ui.lock'), 'utf-8'));
      expect(lock.port).toBe(handle.port);
    } finally {
      await new Promise<void>((done) => blocker.close(() => done()));
    }
  });

  test('/api/config returns collabUrl=null when server.lock is absent', async () => {
    handle = await startUiServer({ config: config(), cwd: tmpDir, port: 0, host: '127.0.0.1' });
    const { status, body, headers } = await get(handle.port, '/api/config');
    expect(status).toBe(200);
    expect(headers.get('content-type')).toContain('application/json');
    const parsed = JSON.parse(body);
    expect(parsed.collabUrl).toBeNull();
    expect(parsed.previewUrl).toBeNull();
    expect(parsed.port).toBe(handle.port);
    expect(parsed.paneTarget).toBeNull();
  });

  test('/api/config returns an armed paneTarget; DELETE consumes it', async () => {
    armPaneTarget(lockDir, '#/specs/foo/SPEC');
    handle = await startUiServer({ config: config(), cwd: tmpDir, port: 0, host: '127.0.0.1' });
    const first = JSON.parse((await get(handle.port, '/api/config')).body);
    expect(first.paneTarget).toBe('#/specs/foo/SPEC');

    const del = await fetch(`http://127.0.0.1:${handle.port}/api/config`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    expect(readArmedPaneTarget(lockDir)).toBeNull();

    const second = JSON.parse((await get(handle.port, '/api/config')).body);
    expect(second.paneTarget).toBeNull();
  });

  test('base-open GET / 302-redirects to an armed pane target and consumes it', async () => {
    armPaneTarget(lockDir, '#/specs/foo/SPEC');
    handle = await startUiServer({ config: config(), cwd: tmpDir, port: 0, host: '127.0.0.1' });

    const res = await fetch(`http://127.0.0.1:${handle.port}/`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/#/specs/foo/SPEC');
    expect(res.headers.get('cache-control')).toBe('no-store');

    expect(readArmedPaneTarget(lockDir)).toBeNull();
    const follow = await fetch(`http://127.0.0.1:${handle.port}/`, { redirect: 'manual' });
    expect(follow.status).not.toBe(302);
  });

  test('base-open GET / does not redirect when no pane target is armed', async () => {
    const dist = seedDist(tmpDir, 'noredir');
    handle = await startUiServer({
      config: config(),
      cwd: tmpDir,
      port: 0,
      host: '127.0.0.1',
      assetDir: dist,
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/`, { redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="root"');
  });

  test('/api/config returns same-origin collabUrl when server.lock has live port', async () => {
    acquireServerLock(lockDir, { port: 0, worktreeRoot: tmpDir });
    updateServerLockPort(lockDir, 54321);

    handle = await startUiServer({ config: config(), cwd: tmpDir, port: 0, host: '127.0.0.1' });
    const { body } = await get(handle.port, '/api/config');
    const parsed = JSON.parse(body);
    expect(parsed.collabUrl).toBe(`ws://127.0.0.1:${handle.port}/collab`);
  });

  test('/api/config has no-store cache-control', async () => {
    handle = await startUiServer({ config: config(), cwd: tmpDir, port: 0, host: '127.0.0.1' });
    const { headers } = await get(handle.port, '/api/config');
    expect(headers.get('cache-control')).toBe('no-store');
  });

  test('HEAD /api/config returns 200 with no body', async () => {
    handle = await startUiServer({ config: config(), cwd: tmpDir, port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/config`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe('');
  });

  test('unknown path returns 404 when no static assets present (tmp dir has no dist)', async () => {
    handle = await startUiServer({ config: config(), cwd: tmpDir, port: 0, host: '127.0.0.1' });
    const { status } = await get(handle.port, '/does-not-exist');
    expect([200, 404]).toContain(status);
  });

  test('GET / serves the SPA shell (rewrites to /index.html)', async () => {
    handle = await startUiServer({ config: config(), cwd: tmpDir, port: 0, host: '127.0.0.1' });
    const root = await get(handle.port, '/');
    const indexHtml = await get(handle.port, '/index.html');
    expect(root.status).toBe(indexHtml.status);
  });

  test('release() removes the ui.lock', async () => {
    handle = await startUiServer({ config: config(), cwd: tmpDir, port: 0, host: '127.0.0.1' });
    const lockPath = resolve(lockDir, 'ui.lock');
    expect(existsSync(lockPath)).toBe(true);

    handle.release();
    expect(existsSync(lockPath)).toBe(false);
    expect(readUiLock(lockDir)).toBeNull();

    if (handle) await closeHttpServers(handle.httpServers);
    handle = null;
  });

  test('D-033: two-socket loopback — second bind via 127.0.0.1 fails loud with EADDRINUSE', async () => {
    const h = await startUiServer({ config: config(), cwd: tmpDir, port: 0 });
    handle = h;
    expect(h.port).toBeGreaterThan(0);
    expect(h.httpServers.length).toBe(2);

    const collider = createHttpServer(() => {});
    let errorCode: string | undefined;
    await new Promise<void>((done) => {
      collider.once('error', (err: NodeJS.ErrnoException) => {
        errorCode = err.code;
        done();
      });
      collider.listen(h.port, '127.0.0.1', () => {
        collider.close(() => done());
      });
    });
    expect(errorCode).toBe('EADDRINUSE');
  });

  test('D-033: two-socket loopback — second bind via [::1] also fails loud', async () => {
    const h = await startUiServer({ config: config(), cwd: tmpDir, port: 0 });
    handle = h;
    const collider = createHttpServer(() => {});
    let errorCode: string | undefined;
    await new Promise<void>((done) => {
      collider.once('error', (err: NodeJS.ErrnoException) => {
        errorCode = err.code;
        done();
      });
      collider.listen(h.port, '::1', () => {
        collider.close(() => done());
      });
    });
    expect(errorCode).toBe('EADDRINUSE');
  });

  test('D-033: two-socket loopback serves both families end-to-end', async () => {
    handle = await startUiServer({ config: config(), cwd: tmpDir, port: 0 });
    const v4 = await fetch(`http://127.0.0.1:${handle.port}/api/config`);
    expect(v4.status).toBe(200);
    const v6 = await fetch(`http://[::1]:${handle.port}/api/config`);
    expect(v6.status).toBe(200);
  });

  test('D-033 / G4: two projects with kernel-allocated port 0 get distinct ports', async () => {
    const otherTmpDir = await mkdtemp(resolve(tmpdir(), 'ok-ui-cmd-test-'));
    handle = await startUiServer({ config: config(), cwd: tmpDir, port: 0 });
    const secondHandle = await startUiServer({
      config: config(),
      cwd: otherTmpDir,
      port: 0,
    });
    try {
      expect(handle.port).toBeGreaterThan(0);
      expect(secondHandle.port).toBeGreaterThan(0);
      expect(handle.port).not.toBe(secondHandle.port);
      const a = await fetch(`http://127.0.0.1:${handle.port}/api/config`);
      const b = await fetch(`http://127.0.0.1:${secondHandle.port}/api/config`);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
    } finally {
      secondHandle.release();
      await closeHttpServers(secondHandle.httpServers);
      await rm(otherTmpDir, { recursive: true, force: true });
    }
  });

  test('GET /api/pages is proxied to the collab server when server.lock is live', async () => {
    const upstream = await startDualLoopbackUpstream((req, res) => {
      if (req.url === '/api/pages') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, source: 'collab', pages: [] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    const upstreamPort = upstream.port;

    acquireServerLock(lockDir, { port: 0, worktreeRoot: tmpDir });
    updateServerLockPort(lockDir, upstreamPort);

    handle = await startUiServer({ config: config(), cwd: tmpDir, port: 0, host: '127.0.0.1' });
    try {
      const { status, body, headers } = await get(handle.port, '/api/pages');
      expect(status).toBe(200);
      expect(headers.get('content-type')).toContain('application/json');
      const parsed = JSON.parse(body);
      expect(parsed).toEqual({ ok: true, source: 'collab', pages: [] });
    } finally {
      await upstream.close();
    }
  });

  test('GET /api/anything returns RFC 9457 problem+json 503 when server.lock is absent', async () => {
    handle = await startUiServer({ config: config(), cwd: tmpDir, port: 0, host: '127.0.0.1' });
    const { status, body, headers } = await get(handle.port, '/api/pages');
    expect(status).toBe(503);
    expect(headers.get('content-type')).toContain('application/problem+json');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('cache-control')).toBe('no-store');
    const parsed = ProblemDetailsSchema.parse(JSON.parse(body));
    expect(parsed.type).toBe('urn:ok:error:collab-server-not-running');
    expect(parsed.title).toContain('Collab server not running');
    expect(parsed.status).toBe(503);
    expect(parsed.instance).toMatch(
      /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(parsed.detail).toContain('/api/pages');
  });

  test('POST /api/create-page forwards method + body to the collab server', async () => {
    const receivedRequests: Array<{ method: string; body: string; contentType: string }> = [];
    const upstream = await startDualLoopbackUpstream((req, res) => {
      if (req.url === '/api/create-page' && req.method === 'POST') {
        let body = '';
        req.setEncoding('utf-8');
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          receivedRequests.push({
            method: req.method ?? '',
            body,
            contentType: String(req.headers['content-type'] ?? ''),
          });
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    const upstreamPort = upstream.port;
    acquireServerLock(lockDir, { port: 0, worktreeRoot: tmpDir });
    updateServerLockPort(lockDir, upstreamPort);

    handle = await startUiServer({ config: config(), cwd: tmpDir, port: 0, host: '127.0.0.1' });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/create-page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docName: 'notes/test', content: '# hi' }),
      });
      expect(res.status).toBe(201);
      const parsed = (await res.json()) as { ok: boolean };
      expect(parsed.ok).toBe(true);
      expect(receivedRequests).toHaveLength(1);
      expect(receivedRequests[0]?.method).toBe('POST');
      expect(receivedRequests[0]?.contentType).toContain('application/json');
      const sent = JSON.parse(receivedRequests[0]?.body ?? '{}');
      expect(sent).toEqual({ docName: 'notes/test', content: '# hi' });
    } finally {
      await upstream.close();
    }
  });

  test('/api/* proxy returns 502 when upstream connection fails', async () => {
    const probe = createHttpServer();
    await new Promise<void>((done) => probe.listen(0, '127.0.0.1', () => done()));
    const deadPort = (probe.address() as { port: number }).port;
    await new Promise<void>((done) => probe.close(() => done()));

    acquireServerLock(lockDir, { port: 0, worktreeRoot: tmpDir });
    updateServerLockPort(lockDir, deadPort);

    handle = await startUiServer({ config: config(), cwd: tmpDir, port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/pages`);
    expect(res.status).toBe(502);
  });

  test('bind failure on an invalid host releases the lock (does not leak)', async () => {
    let caught: unknown;
    try {
      await startUiServer({
        config: config(),
        cwd: tmpDir,
        port: 0,
        host: '240.0.0.1',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(readUiLock(lockDir)).toBeNull();
  });

  test('starts when the content root contains a broken symlink', async () => {
    symlinkSync(resolve(tmpDir, 'missing-target'), resolve(tmpDir, 'broken-link'));

    handle = await startUiServer({ config: config(), cwd: tmpDir, port: 0, host: '127.0.0.1' });
    const { status } = await get(handle.port, '/api/config');
    expect(status).toBe(200);
  });

  test('asset serve: missing asset-extension URL returns 404 (not SPA index.html)', async () => {
    const fs = await import('node:fs');
    const seedFile = resolve(tmpDir, 'doc.md');
    fs.writeFileSync(seedFile, '# seed', 'utf-8');

    handle = await startUiServer({ config: config(), cwd: tmpDir, port: 0, host: '127.0.0.1' });
    const { status, headers } = await get(handle.port, '/missing.m4v');
    expect(status).toBe(404);
    expect(headers.get('content-type') ?? '').not.toMatch(/^text\/html/);
  });

  test('asset serve: existing inline-renderable asset gets Content-Disposition: inline', async () => {
    const fs = await import('node:fs');
    const seedDoc = resolve(tmpDir, 'doc.md');
    fs.writeFileSync(seedDoc, '# seed', 'utf-8');
    const seedAsset = resolve(tmpDir, 'photo.png');
    fs.writeFileSync(seedAsset, 'fake-png', 'binary');

    handle = await startUiServer({ config: config(), cwd: tmpDir, port: 0, host: '127.0.0.1' });
    const { status, headers } = await get(handle.port, '/photo.png');
    expect(status).toBe(200);
    expect(headers.get('content-disposition')).toBe('inline');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('SPA-bundle assets under /assets/ serve from dist/ (regression: woff2 fonts)', async () => {
    const distAssets = resolve(import.meta.dirname, '../../../app/dist/assets');
    if (!existsSync(distAssets)) return; // No built app — skip in CI without `bun run build`.
    const fontFile = readdirSync(distAssets).find((name) => name.endsWith('.woff2'));
    if (!fontFile) return; // Build emitted no fonts — nothing to assert.

    handle = await startUiServer({ config: config(), cwd: tmpDir, port: 0, host: '127.0.0.1' });
    const { status, headers } = await get(handle.port, `/assets/${fontFile}`);
    expect(status).toBe(200);
    expect(headers.get('content-disposition')).toBeNull();
  });

  test('SPA bundle: a hashed asset added AFTER boot serves without restart (stale-build fix)', async () => {
    const distDir = seedDist(tmpDir, 'AAAA');
    handle = await startUiServer({
      config: config(),
      cwd: tmpDir,
      port: 0,
      host: '127.0.0.1',
      assetDir: distDir,
    });

    expect((await get(handle.port, '/assets/app-AAAA.js')).status).toBe(200);

    writeFileSync(resolve(distDir, 'assets', 'app-BBBB.js'), 'console.log("BBBB");');
    writeFileSync(
      resolve(distDir, 'index.html'),
      '<!doctype html><html><head><script type="module" src="/assets/app-BBBB.js"></script></head><body><div id="root"></div></body></html>',
    );

    const after = await get(handle.port, '/assets/app-BBBB.js');
    expect(after.status).toBe(200);

    const htmlAfter = await get(handle.port, '/index.html');
    expect(htmlAfter.body).toContain('app-BBBB.js');
  });

  test('SPA bundle: a missing /assets/*.js returns a plain 404, not the API problem+json', async () => {
    const distDir = seedDist(tmpDir, 'AAAA');
    handle = await startUiServer({
      config: config(),
      cwd: tmpDir,
      port: 0,
      host: '127.0.0.1',
      assetDir: distDir,
    });

    const res = await get(handle.port, '/assets/app-DOESNOTEXIST.js');
    expect(res.status).toBe(404);
    const contentType = res.headers.get('content-type') ?? '';
    expect(contentType).not.toContain('application/problem+json'); // not the API envelope
    expect(contentType).not.toMatch(/^text\/html/); // not the SPA shell
    expect(res.body).toBe(''); // plain, empty static 404
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('SPA bundle: an unchanged asset revalidates with 304 via If-None-Match (etag)', async () => {
    const distDir = seedDist(tmpDir, 'AAAA');
    handle = await startUiServer({
      config: config(),
      cwd: tmpDir,
      port: 0,
      host: '127.0.0.1',
      assetDir: distDir,
    });

    const first = await fetch(`http://127.0.0.1:${handle.port}/assets/app-AAAA.js`);
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    expect(first.headers.get('cache-control') ?? '').not.toBe('no-store');

    const second = await fetch(`http://127.0.0.1:${handle.port}/assets/app-AAAA.js`, {
      headers: { 'If-None-Match': etag as string },
    });
    expect(second.status).toBe(304);
  });

  test('SPA-bundle /assets/ falls through to content middleware when sirv misses', async () => {
    const fs = await import('node:fs');
    const assetsDir = resolve(tmpDir, 'assets');
    mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(resolve(tmpDir, 'doc.md'), '# seed', 'utf-8');
    fs.writeFileSync(resolve(assetsDir, 'user-upload.png'), 'fake-png', 'binary');

    handle = await startUiServer({ config: config(), cwd: tmpDir, port: 0, host: '127.0.0.1' });
    const { status, headers } = await get(handle.port, '/assets/user-upload.png');
    expect(status).toBe(200);
    expect(headers.get('content-disposition')).toBe('inline');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('asset serve: content .html is served only inside a sandbox CSP (stored-XSS defense)', async () => {
    const fs = await import('node:fs');
    const seedDoc = resolve(tmpDir, 'doc.md');
    fs.writeFileSync(seedDoc, '# seed', 'utf-8');
    const seedHtml = resolve(tmpDir, 'viewer.html');
    fs.writeFileSync(seedHtml, '<h1>viewer</h1><script>alert(1)</script>', 'utf-8');

    handle = await startUiServer({ config: config(), cwd: tmpDir, port: 0, host: '127.0.0.1' });
    const { status, headers } = await get(handle.port, '/viewer.html');
    expect(status).toBe(200);
    expect(headers.get('content-disposition')).toBe('inline');
    expect(headers.get('content-security-policy')).toBe(
      "sandbox allow-scripts; connect-src 'none'",
    );
    expect(headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('asset serve: SPA app shell (/index.html miss) is NOT sandboxed', async () => {
    const dist = seedDist(tmpDir, 'noshell');
    handle = await startUiServer({
      config: config(),
      cwd: tmpDir,
      port: 0,
      host: '127.0.0.1',
      assetDir: dist,
    });
    const { status, headers } = await get(handle.port, '/index.html');
    expect(status).toBe(200);
    expect(headers.get('content-security-policy')).toBeNull();
    expect(headers.get('content-disposition')).toBeNull();
  });

  test('/api/* gate rejects requests with non-loopback Host header (DNS-rebind defense)', async () => {
    handle = await startUiServer({ config: config(), cwd: tmpDir, port: 0, host: '127.0.0.1' });
    const res = await rawRequest({
      port: handle.port,
      path: '/api/config',
      host: 'attacker.com:1234',
    });
    expect(res.status).toBe(403);
    expect(String(res.headers['content-type'] ?? '')).toContain('application/problem+json');
    const body = JSON.parse(res.body) as { type: string; title: string; status: number };
    expect(body.type).toBe('urn:ok:error:host-not-allowed');
    expect(body.status).toBe(403);
  });

  test('/api/* gate rejects requests with non-loopback Origin (CSRF defense)', async () => {
    handle = await startUiServer({ config: config(), cwd: tmpDir, port: 0, host: '127.0.0.1' });
    const res = await rawRequest({
      port: handle.port,
      path: '/api/config',
      origin: 'http://attacker.com',
    });
    expect(res.status).toBe(403);
    const body = JSON.parse(res.body) as { type: string; title: string; status: number };
    expect(body.type).toBe('urn:ok:error:invalid-origin');
  });

  test('/api/* gate accepts loopback Origin (legitimate Vite dev server)', async () => {
    handle = await startUiServer({ config: config(), cwd: tmpDir, port: 0, host: '127.0.0.1' });
    const res = await rawRequest({
      port: handle.port,
      path: '/api/config',
      origin: 'http://localhost:5173',
    });
    expect(res.status).toBe(200);
  });

  test('/api/* gate accepts Origin: null (Electron packaged renderer)', async () => {
    handle = await startUiServer({ config: config(), cwd: tmpDir, port: 0, host: '127.0.0.1' });
    const res = await rawRequest({
      port: handle.port,
      path: '/api/config',
      origin: 'null',
    });
    expect(res.status).toBe(200);
  });

  test('/api/* proxy gate rejects DNS-rebind Host even when collab server is up', async () => {
    let upstreamHits = 0;
    const upstream = await startDualLoopbackUpstream((_req, res) => {
      upstreamHits++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const upstreamPort = upstream.port;
    acquireServerLock(lockDir, { port: 0, worktreeRoot: tmpDir });
    updateServerLockPort(lockDir, upstreamPort);

    handle = await startUiServer({ config: config(), cwd: tmpDir, port: 0, host: '127.0.0.1' });
    try {
      const res = await rawRequest({
        port: handle.port,
        path: '/api/agent-write-md',
        method: 'POST',
        host: 'attacker.com:1234',
        contentType: 'application/json',
        body: JSON.stringify({ docName: 'malicious', content: 'pwn' }),
      });
      expect(res.status).toBe(403);
      const body = JSON.parse(res.body) as { type: string; title: string; status: number };
      expect(body.type).toBe('urn:ok:error:host-not-allowed');
      expect(upstreamHits).toBe(0);
    } finally {
      await upstream.close();
    }
  });

  test('non-/api/* paths are NOT subject to the gate (Host check would harm SPA)', async () => {
    handle = await startUiServer({ config: config(), cwd: tmpDir, port: 0, host: '127.0.0.1' });
    const res = await rawRequest({
      port: handle.port,
      path: '/missing.png',
      host: 'attacker.com:1234',
    });
    expect(res.status).not.toBe(403);
  });

  test('asset serve: non-inline admitted asset gets Content-Disposition: attachment', async () => {
    const fs = await import('node:fs');
    const seedDoc = resolve(tmpDir, 'doc.md');
    fs.writeFileSync(seedDoc, '# seed', 'utf-8');
    const seedZip = resolve(tmpDir, 'archive.zip');
    fs.writeFileSync(seedZip, 'fake-zip-bytes', 'binary');

    handle = await startUiServer({ config: config(), cwd: tmpDir, port: 0, host: '127.0.0.1' });
    const { status, headers } = await get(handle.port, '/archive.zip');
    expect(status).toBe(200);
    expect(headers.get('content-disposition')).toBe('attachment');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('startUiServer — D-025 12h safety-net', () => {
  test('default safety-net is 12 hours', () => {
    expect(DEFAULT_UI_SAFETY_NET_MS).toBe(12 * 60 * 60 * 1000);
  });

  test('schedules a safety-net timer with the configured interval', async () => {
    const scheduler = createManualScheduler();
    handle = await startUiServer({
      config: config(),
      cwd: tmpDir,
      port: 0,
      host: '127.0.0.1',
      safetyNetMs: 60_000,
      scheduler,
    });
    expect(scheduler.pendingCount()).toBe(1);
  });

  test('safety-net fires after the configured interval — closes server, releases lock, invokes onSafetyNet', async () => {
    const scheduler = createManualScheduler();
    let onSafetyNetFired = 0;
    handle = await startUiServer({
      config: config(),
      cwd: tmpDir,
      port: 0,
      host: '127.0.0.1',
      safetyNetMs: 60_000,
      scheduler,
      onSafetyNet: () => {
        onSafetyNetFired++;
      },
    });
    const port = handle.port;
    const lockPath = resolve(lockDir, 'ui.lock');
    expect(existsSync(lockPath)).toBe(true);

    scheduler.advanceTime(60_000);
    expect(onSafetyNetFired).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
    expect(readUiLock(lockDir)).toBeNull();

    if (handle) await closeHttpServers(handle.httpServers);
    let connectError: unknown = null;
    try {
      await fetch(`http://127.0.0.1:${port}/api/config`);
    } catch (err) {
      connectError = err;
    }
    expect(connectError).not.toBeNull();
    handle = null; // afterEach already cleaned up.
  });

  test('release() before fire cancels the safety-net timer', async () => {
    const scheduler = createManualScheduler();
    let onSafetyNetFired = 0;
    handle = await startUiServer({
      config: config(),
      cwd: tmpDir,
      port: 0,
      host: '127.0.0.1',
      safetyNetMs: 60_000,
      scheduler,
      onSafetyNet: () => {
        onSafetyNetFired++;
      },
    });
    expect(scheduler.pendingCount()).toBe(1);

    handle.release();
    expect(scheduler.pendingCount()).toBe(0);

    scheduler.advanceTime(60_000 * 100);
    expect(onSafetyNetFired).toBe(0);
  });

  test('detachSafetyNet() cancels the timer without releasing the lock', async () => {
    const scheduler = createManualScheduler();
    handle = await startUiServer({
      config: config(),
      cwd: tmpDir,
      port: 0,
      host: '127.0.0.1',
      safetyNetMs: 60_000,
      scheduler,
    });
    const lockPath = resolve(lockDir, 'ui.lock');
    expect(existsSync(lockPath)).toBe(true);

    handle.detachSafetyNet();
    expect(scheduler.pendingCount()).toBe(0);
    expect(existsSync(lockPath)).toBe(true);
  });

  test('release() is idempotent — second call is a no-op', async () => {
    handle = await startUiServer({ config: config(), cwd: tmpDir, port: 0, host: '127.0.0.1' });
    const lockPath = resolve(lockDir, 'ui.lock');

    handle.release();
    expect(existsSync(lockPath)).toBe(false);
    handle.release();
    expect(existsSync(lockPath)).toBe(false);

    if (handle) await closeHttpServers(handle.httpServers);
    handle = null;
  });

  test('safetyNetMs=0 disables the safety-net entirely (no timer scheduled)', async () => {
    const scheduler = createManualScheduler();
    handle = await startUiServer({
      config: config(),
      cwd: tmpDir,
      port: 0,
      host: '127.0.0.1',
      safetyNetMs: 0,
      scheduler,
    });
    expect(scheduler.pendingCount()).toBe(0);
  });
});

describe('resolveUiLockCollision', () => {
  function fakeLock(port: number): UiLockMetadata {
    return {
      pid: process.pid,
      hostname: 'localhost',
      port,
      startedAt: new Date().toISOString(),
      worktreeRoot: tmpDir,
    };
  }

  test('same port as holder → already-running', async () => {
    const result = await resolveUiLockCollision({
      requestedPort: 3000,
      host: '127.0.0.1',
      lockDir,
      readLock: () => fakeLock(3000),
    });
    expect(result.mode).toBe('already-running');
    if (result.mode === 'already-running') expect(result.port).toBe(3000);
  });

  test('throws when lock disappeared mid-handle', async () => {
    await expect(
      resolveUiLockCollision({
        requestedPort: 3000,
        host: '127.0.0.1',
        lockDir,
        readLock: () => null,
      }),
    ).rejects.toThrow(/disappeared/);
  });

  test('different port + live upstream → proxy mode forwards correctly', async () => {
    const upstream = await startDualLoopbackUpstream((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('upstream ok');
    });
    const upstreamPort = upstream.port;

    const result = await resolveUiLockCollision({
      requestedPort: 0, // kernel-allocated so we don't conflict with anything
      host: '127.0.0.1',
      lockDir,
      readLock: () => fakeLock(upstreamPort),
    });

    expect(result.mode).toBe('proxy');
    if (result.mode !== 'proxy') throw new Error('unreachable');
    expect(result.upstreamPort).toBe(upstreamPort);

    try {
      const response = await fetch(`http://127.0.0.1:${result.handle.port}/`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('upstream ok');
    } finally {
      await result.handle.close();
      await upstream.close();
    }
  });

  test('proxy returns 502 when upstream dies', async () => {
    const probe = createHttpServer();
    await new Promise<void>((done) => probe.listen(0, '127.0.0.1', () => done()));
    const deadPort = (probe.address() as { port: number }).port;
    await new Promise<void>((done) => probe.close(() => done()));

    const result = await resolveUiLockCollision({
      requestedPort: 0,
      host: '127.0.0.1',
      lockDir,
      readLock: () => fakeLock(deadPort),
    });
    if (result.mode !== 'proxy') throw new Error('unreachable');

    try {
      const response = await fetch(`http://127.0.0.1:${result.handle.port}/`);
      expect(response.status).toBe(502);
    } finally {
      await result.handle.close();
    }
  });

  test('lock port=0 that becomes live within deadline → proxy mode', async () => {
    const upstream = await startDualLoopbackUpstream((_req, res) => res.end('late upstream'));
    const upstreamPort = upstream.port;

    let calls = 0;
    const readLock = () => {
      calls++;
      return calls < 3 ? fakeLock(0) : fakeLock(upstreamPort);
    };

    const result = await resolveUiLockCollision({
      requestedPort: 0,
      host: '127.0.0.1',
      lockDir,
      readLock,
      pollIntervalMs: 10,
      pollDeadlineMs: 2000,
    });

    expect(result.mode).toBe('proxy');
    if (result.mode !== 'proxy') throw new Error('unreachable');
    expect(result.upstreamPort).toBe(upstreamPort);

    await result.handle.close();
    await upstream.close();
  });

  test('lock port=0 that stays 0 → throws timeout error', async () => {
    await expect(
      resolveUiLockCollision({
        requestedPort: 3000,
        host: '127.0.0.1',
        lockDir,
        readLock: () => fakeLock(0),
        pollIntervalMs: 5,
        pollDeadlineMs: 25,
      }),
    ).rejects.toThrow(/did not bind within 2s/);
  });

  test('lock port=0 that resolves equal to requested port → already-running', async () => {
    let calls = 0;
    const readLock = () => {
      calls++;
      return calls < 3 ? fakeLock(0) : fakeLock(4321);
    };

    const result = await resolveUiLockCollision({
      requestedPort: 4321,
      host: '127.0.0.1',
      lockDir,
      readLock,
      pollIntervalMs: 5,
      pollDeadlineMs: 500,
    });

    expect(result.mode).toBe('already-running');
    if (result.mode === 'already-running') expect(result.port).toBe(4321);
  });
});

describe('isNonInteractiveContext — PRD-6704 keepalive gate', () => {
  function makeProc(opts: {
    isTTY: boolean;
    port?: string;
  }): Pick<NodeJS.Process, 'stdout' | 'env'> {
    const env = (opts.port === undefined ? {} : { PORT: opts.port }) as NodeJS.ProcessEnv;
    return {
      stdout: { isTTY: opts.isTTY } as NodeJS.Process['stdout'],
      env,
    };
  }

  test('no TTY + no PORT env → non-interactive (subprocess case)', () => {
    expect(isNonInteractiveContext(makeProc({ isTTY: false }))).toBe(true);
  });

  test('no TTY + PORT env → non-interactive', () => {
    expect(isNonInteractiveContext(makeProc({ isTTY: false, port: '39848' }))).toBe(true);
  });

  test('TTY + PORT env → non-interactive (Claude Code Desktop pattern)', () => {
    expect(isNonInteractiveContext(makeProc({ isTTY: true, port: '39848' }))).toBe(true);
  });

  test('TTY + no PORT env → interactive (operator at a terminal)', () => {
    expect(isNonInteractiveContext(makeProc({ isTTY: true }))).toBe(false);
  });

  test('TTY + empty PORT env string is treated as no PORT (defense-in-depth)', () => {
    expect(isNonInteractiveContext(makeProc({ isTTY: true, port: '' }))).toBe(false);
  });
});
