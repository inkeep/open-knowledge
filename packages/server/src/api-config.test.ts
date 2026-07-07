import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { createApiExtension } from './api-extension.ts';
import { getLocalDir } from './config/paths.ts';
import { armPaneTarget } from './pane-target.ts';
import { acquireServerLock } from './server-lock.ts';

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function makeReq(
  method: string,
  url: string,
  headers: Record<string, string> = { host: 'localhost:7777' },
): IncomingMessage {
  const readable = Readable.from(Buffer.from('')) as unknown as IncomingMessage;
  readable.method = method;
  readable.url = url;
  readable.headers = headers;
  return readable;
}

function makeRes(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, headers: {}, body: '' };
  const res = {
    statusCode: 0,
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
    },
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      if (headers) {
        for (const [k, v] of Object.entries(headers)) captured.headers[k.toLowerCase()] = v;
      }
    },
    end(body?: string) {
      // Handlers that set `res.statusCode` directly (vs writeHead) surface it here.
      if (captured.status === 0) captured.status = (this as { statusCode: number }).statusCode;
      captured.body = body ?? '';
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

function buildExtension(projectDir: string | undefined) {
  return createApiExtension({
    hocuspocus: {} as unknown as Parameters<typeof createApiExtension>[0]['hocuspocus'],
    sessionManager: {} as unknown as Parameters<typeof createApiExtension>[0]['sessionManager'],
    contentDir: projectDir ?? '/tmp/ok-no-project',
    serverInstanceId: 'test-server',
    getFileIndex: () => new Map(),
    projectDir,
  });
}

async function call(
  ext: ReturnType<typeof buildExtension>,
  method: string,
  url: string,
  headers?: Record<string, string>,
): Promise<CapturedResponse> {
  const req = headers ? makeReq(method, url, headers) : makeReq(method, url);
  const { res, captured } = makeRes();
  await (
    ext as {
      onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
    }
  ).onRequest({ request: req, response: res });
  return captured;
}

describe('GET /api/config (desktop / worktree collab server)', () => {
  test('returns the ok-ui-shaped bootstrap payload with same-origin collabUrl', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-config-'));
    try {
      const result = await call(buildExtension(dir), 'GET', '/api/config');
      expect(result.status).toBe(200);
      expect(result.headers['content-type']).toBe('application/json');
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.headers['x-content-type-options']).toBe('nosniff');
      const body = JSON.parse(result.body) as {
        collabUrl: string | null;
        previewUrl: string | null;
        port: number;
        paneTarget: string | null;
      };
      expect(body.collabUrl).toBe('ws://localhost:7777/collab');
      expect(body.previewUrl).toBeNull();
      expect(body.paneTarget).toBeNull();
      expect(typeof body.port).toBe('number');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('surfaces an armed pane target', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-config-'));
    try {
      armPaneTarget(getLocalDir(dir), '#/bim-brain/articles/');
      const result = await call(buildExtension(dir), 'GET', '/api/config');
      const body = JSON.parse(result.body) as { paneTarget: string | null };
      expect(body.paneTarget).toBe('#/bim-brain/articles/');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reports the bound server port from server.lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-config-'));
    try {
      acquireServerLock(getLocalDir(dir), { port: 54321, worktreeRoot: dir });
      const result = await call(buildExtension(dir), 'GET', '/api/config');
      const body = JSON.parse(result.body) as { port: number };
      expect(body.port).toBe(54321);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('HEAD returns headers + 200 with no body', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-config-'));
    try {
      const result = await call(buildExtension(dir), 'HEAD', '/api/config');
      expect(result.status).toBe(200);
      expect(result.headers['content-type']).toBe('application/json');
      expect(result.body).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns collabUrl null when the Host header is absent (deliberate divergence from ok ui)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-config-'));
    try {
      // No Host header at all. Unlike `ok ui` (which falls back to
      // `localhost:${resolvedPort}`), this handler advertises null and lets
      // the client fall back to a same-origin WS URL. Pin it so a future
      // change that silently adds a fallback is loud.
      const result = await call(buildExtension(dir), 'GET', '/api/config', {});
      expect(result.status).toBe(200);
      const body = JSON.parse(result.body) as { collabUrl: string | null };
      expect(body.collabUrl).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('degrades to a null pane target / zero port when projectDir is unconfigured', async () => {
    const result = await call(buildExtension(undefined), 'GET', '/api/config');
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body) as { port: number; paneTarget: string | null };
    expect(body.port).toBe(0);
    expect(body.paneTarget).toBeNull();
  });
});

describe('DELETE /api/config one-shot consume', () => {
  test('clears the armed pane target so a later GET no longer surfaces it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-config-'));
    try {
      const localDir = getLocalDir(dir);
      armPaneTarget(localDir, '#/specs/foo/SPEC');
      expect(existsSync(resolve(localDir, 'pane-target.json'))).toBe(true);

      const del = await call(buildExtension(dir), 'DELETE', '/api/config');
      expect(del.status).toBe(204);
      expect(del.body).toBe('');
      expect(existsSync(resolve(localDir, 'pane-target.json'))).toBe(false);

      const after = await call(buildExtension(dir), 'GET', '/api/config');
      const body = JSON.parse(after.body) as { paneTarget: string | null };
      expect(body.paneTarget).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('DELETE from a non-loopback Host is rejected and does not clear the arm (DNS-rebind gate)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-config-'));
    try {
      const localDir = getLocalDir(dir);
      armPaneTarget(localDir, '#/specs/foo/SPEC');

      const del = await call(buildExtension(dir), 'DELETE', '/api/config', {
        host: 'evil.example.com',
      });
      expect(del.status).toBe(403);
      // The arm must survive a rejected DELETE — a DNS-rebound page must not
      // be able to clear local TTL state.
      expect(existsSync(resolve(localDir, 'pane-target.json'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('/api/config rejects unsupported methods', () => {
  test('POST returns 405 method-not-allowed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-config-'));
    try {
      const result = await call(buildExtension(dir), 'POST', '/api/config');
      expect(result.status).toBe(405);
      expect(result.headers.allow).toBe('GET, HEAD, DELETE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
