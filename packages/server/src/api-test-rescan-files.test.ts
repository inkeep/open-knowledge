/**
 * Unit coverage for the `POST /api/test-rescan-files` endpoint — the file-index
 * counterpart of `/api/test-rescan-backlinks`. Both endpoints exist to recover
 * from the @parcel/watcher + inotify race on Linux CI (dropped IN_CREATE events
 * for files written into freshly-created subdirectories). See the
 * `awaitFileWatcherIndexed` helper in `test-harness.ts` for the integration
 * caller.
 *
 * Three scenarios mirror the sibling `POST /api/test-rescan-backlinks` suite
 * in `api-backlinks.test.ts`:
 *   1. Happy path — `enableTestRoutes=true` + a configured `rescanFiles`
 *      callback returns 200 and invokes the callback.
 *   2. Production gate — without `enableTestRoutes` the route returns 404
 *      (the route is unregistered, so dispatch falls through to the not-found
 *      handler).
 *   3. Method gate — non-POST methods return 405.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createApiExtension } from './api-extension.ts';
import type { FileIndexEntry } from './file-watcher.ts';

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function makeReq(url: string, method = 'GET'): IncomingMessage {
  const readable = Readable.from(Buffer.from('')) as unknown as IncomingMessage;
  readable.method = method;
  readable.url = url;
  readable.headers = { host: 'localhost' };
  return readable;
}

function makeRes(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, headers: {}, body: '' };
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      if (headers) Object.assign(captured.headers, headers);
    },
    end(body?: string) {
      captured.body = body ?? '';
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

async function callRoute(
  contentDir: string,
  url: string,
  options?: {
    method?: string;
    enableTestRoutes?: boolean;
    rescanFiles?: () => void;
  },
): Promise<CapturedResponse> {
  const fileIndex = new Map<string, FileIndexEntry>();
  const ext = createApiExtension({
    hocuspocus: {} as never,
    sessionManager: {} as never,
    contentDir,
    getFileIndex: () => fileIndex,
    rescanFiles: options?.rescanFiles,
    enableTestRoutes: options?.enableTestRoutes,
  });
  const req = makeReq(url, options?.method ?? 'GET');
  const { res, captured } = makeRes();
  await (
    ext as {
      onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
    }
  ).onRequest({ request: req, response: res });
  return captured;
}

describe('POST /api/test-rescan-files', () => {
  test('invokes rescanFiles callback and returns 200 when enableTestRoutes=true', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-rescan-files-api-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });

    try {
      let invocations = 0;
      const rescanFiles = (): void => {
        invocations += 1;
      };

      const resp = await callRoute(contentDir, '/api/test-rescan-files', {
        method: 'POST',
        enableTestRoutes: true,
        rescanFiles,
      });

      expect(resp.status).toBe(200);
      // Closes the parity gap with the sibling `test-rescan-backlinks` suite —
      // a regression that emits text/plain or omits the Content-Type would
      // pass otherwise.
      expect(resp.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(resp.body)).toEqual({});
      // The callback ran exactly once — this is the load-bearing handoff that
      // makes the endpoint useful. If the wiring drops to a no-op handler,
      // tests using `awaitFileWatcherIndexed`'s rescue would silently fail
      // back to the 45 s timeout error instead of recovering.
      expect(invocations).toBe(1);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('returns 503 when rescanFiles capability is not configured', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-rescan-files-noop-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });

    try {
      // enableTestRoutes=true but rescanFiles omitted from options — this is
      // the configuration safety net: if a host (e.g. mid-port server-factory
      // refactor) forgets to wire the watcher's rescanFromDisk callback, the
      // endpoint fails loud rather than silently no-op-200ing.
      const resp = await callRoute(contentDir, '/api/test-rescan-files', {
        method: 'POST',
        enableTestRoutes: true,
        // rescanFiles intentionally omitted
      });

      expect(resp.status).toBe(503);
      expect(resp.headers['Content-Type']).toBe('application/problem+json');
      const body = JSON.parse(resp.body);
      expect(body.type).toBe('urn:ok:error:file-rescan-not-configured');
      expect(body.title).toBe('Watcher rescan capability is not configured.');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('returns 404 when enableTestRoutes is not set (default)', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-rescan-files-gate-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });

    try {
      const resp = await callRoute(contentDir, '/api/test-rescan-files', {
        method: 'POST',
        // enableTestRoutes intentionally omitted — production-default state
        rescanFiles: () => {
          throw new Error('rescanFiles must not be invoked when the route is unregistered');
        },
      });
      // Same shape as `/api/test-rescan-backlinks`' production-gate test: the
      // unregistered route falls through to the dispatch-not-found handler
      // (RFC 9457 problem+json).
      expect(resp.status).toBe(404);
      expect(resp.headers['Content-Type']).toBe('application/problem+json');
      const body = JSON.parse(resp.body);
      expect(body.type).toBe('urn:ok:error:not-found');
      expect(body.title).toBe('API endpoint not found.');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('405s on non-POST methods', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-rescan-files-method-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });

    try {
      let invocations = 0;
      const resp = await callRoute(contentDir, '/api/test-rescan-files', {
        method: 'GET',
        enableTestRoutes: true,
        rescanFiles: () => {
          invocations += 1;
        },
      });
      expect(resp.status).toBe(405);
      expect(resp.headers['Content-Type']).toBe('application/problem+json');
      expect(resp.headers.Allow).toBe('POST');
      const body = JSON.parse(resp.body);
      expect(body.type).toBe('urn:ok:error:method-not-allowed');
      // Method gate fires before the handler runs — rescanFiles must not be
      // invoked on a wrong-method request.
      expect(invocations).toBe(0);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
