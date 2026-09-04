import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { createApiExtension } from './api-extension.test-helper.ts';
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
      expect(resp.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(resp.body)).toEqual({});
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
      const resp = await callRoute(contentDir, '/api/test-rescan-files', {
        method: 'POST',
        enableTestRoutes: true,
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
        rescanFiles: () => {
          throw new Error('rescanFiles must not be invoked when the route is unregistered');
        },
      });
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
      expect(invocations).toBe(0);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
