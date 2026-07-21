/**
 * Request-identity + access-log behavior of the `onRequest` gate stack:
 * `x-request-id` echo (minted or honored), gate-rejection coverage, the
 * `ok.request.id`/access-log plumbing, and route-TEMPLATE cardinality on the
 * `api.access` line (never the raw path).
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApiExtension } from './api-extension.ts';
import type { FileIndexEntry } from './file-watcher.ts';
import { loggerFactory } from './logger.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  setHeaders: Record<string, string>;
  body: string;
}

function makeReq(url: string, extraHeaders: Record<string, string> = {}): IncomingMessage {
  const readable = Readable.from(Buffer.from('')) as unknown as IncomingMessage;
  readable.method = 'GET';
  readable.url = url;
  readable.headers = { host: 'localhost', ...extraHeaders };
  return readable;
}

/**
 * Mock `ServerResponse` with the surface the gate stack exercises:
 * `setHeader` (header echo), `once` + synchronous `'finish'` dispatch on
 * `end()` (access log), and `statusCode` tracking through `writeHead`.
 */
function makeRes(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, headers: {}, setHeaders: {}, body: '' };
  const listeners: Record<string, Array<() => void>> = {};
  const res = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    writableFinished: false,
    destroyed: false,
    setHeader(name: string, value: string) {
      captured.setHeaders[name.toLowerCase()] = value;
    },
    once(event: string, fn: () => void) {
      listeners[event] ??= [];
      listeners[event].push(fn);
      return res;
    },
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      res.statusCode = status;
      res.headersSent = true;
      if (headers) Object.assign(captured.headers, headers);
      return res;
    },
    end(body?: string) {
      captured.body = body ?? '';
      res.writableEnded = true;
      res.writableFinished = true;
      for (const fn of listeners.finish ?? []) fn();
      for (const fn of listeners.close ?? []) fn();
    },
  };
  return { res: res as unknown as ServerResponse, captured };
}

describe('onRequest request identity + access log', () => {
  let projectDir: string;
  let contentDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'ok-request-id-'));
    contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function callRoute(
    url: string,
    headers: Record<string, string> = {},
  ): Promise<CapturedResponse> {
    const ext = createApiExtension({
      hocuspocus: {} as never,
      sessionManager: {} as never,
      contentDir,
      getFileIndex: () => new Map<string, FileIndexEntry>(),
    });
    const req = makeReq(url, headers);
    const { res, captured } = makeRes();
    await (
      ext as {
        onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
      }
    ).onRequest({ request: req, response: res });
    return captured;
  }

  test('mints a UUID x-request-id echo when the client sends none', async () => {
    const captured = await callRoute('/api/nonexistent-route');
    expect(captured.status).toBe(404);
    expect(captured.setHeaders['x-request-id']).toMatch(UUID_RE);
  });

  test('honors a well-formed incoming x-request-id', async () => {
    const captured = await callRoute('/api/nonexistent-route', {
      'x-request-id': 'caller-supplied.001',
    });
    expect(captured.setHeaders['x-request-id']).toBe('caller-supplied.001');
  });

  test('replaces a malformed incoming x-request-id with a minted UUID', async () => {
    const captured = await callRoute('/api/nonexistent-route', {
      'x-request-id': 'bad id with spaces',
    });
    expect(captured.setHeaders['x-request-id']).toMatch(UUID_RE);
    expect(captured.setHeaders['x-request-id']).not.toBe('bad id with spaces');
  });

  test('origin-gate 403 rejections still carry the x-request-id echo', async () => {
    const captured = await callRoute('/api/documents', {
      origin: 'https://evil.example.com',
    });
    expect(captured.status).toBe(403);
    expect(JSON.parse(captured.body).type).toBe('urn:ok:error:invalid-origin');
    expect(captured.setHeaders['x-request-id']).toMatch(UUID_RE);
  });

  test('exposes the header to cross-origin readers and allows it on requests', async () => {
    const captured = await callRoute('/api/nonexistent-route', {
      origin: 'http://localhost:5173',
    });
    expect(captured.setHeaders['access-control-expose-headers']).toBe('x-request-id');
    expect(captured.setHeaders['access-control-allow-headers']).toContain('x-request-id');
  });

  test('emits ONE api.access line with the route TEMPLATE, status, duration, and request id', async () => {
    const log = loggerFactory.getLogger('api');
    const infoSpy = vi.spyOn(log, 'info');
    // Empty dynamic segment: templated as /api/history/:sha but dispatches
    // nothing, so the request closes as an api-dispatch 404 without touching
    // handler dependencies.
    const captured = await callRoute('/api/history/');
    const accessCalls = infoSpy.mock.calls.filter(
      (c) => (c[0] as { event?: string })?.event === 'api.access',
    );
    expect(accessCalls).toHaveLength(1);
    const line = accessCalls[0]?.[0] as {
      requestId: string;
      method: string;
      route: string;
      status: number;
      durationMs: number;
    };
    expect(line.route).toBe('/api/history/:sha');
    expect(line.route).not.toBe('/api/history/');
    expect(line.method).toBe('GET');
    expect(line.status).toBe(404);
    expect(typeof line.durationMs).toBe('number');
    expect(line.requestId).toBe(captured.setHeaders['x-request-id']);
  });

  test('unmatched routes collapse to the /api/* template on the access line', async () => {
    const log = loggerFactory.getLogger('api');
    const infoSpy = vi.spyOn(log, 'info');
    await callRoute('/api/no-such-endpoint-xyz');
    const accessCalls = infoSpy.mock.calls.filter(
      (c) => (c[0] as { event?: string })?.event === 'api.access',
    );
    expect(accessCalls).toHaveLength(1);
    expect((accessCalls[0]?.[0] as { route: string }).route).toBe('/api/*');
  });

  test('non-API requests get no x-request-id echo and no access line', async () => {
    const log = loggerFactory.getLogger('api');
    const infoSpy = vi.spyOn(log, 'info');
    const captured = await callRoute('/some/static/path.css');
    expect(captured.setHeaders['x-request-id']).toBeUndefined();
    const accessCalls = infoSpy.mock.calls.filter(
      (c) => (c[0] as { event?: string })?.event === 'api.access',
    );
    expect(accessCalls).toHaveLength(0);
  });
});
