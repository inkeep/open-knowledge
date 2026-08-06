/**
 * Unit + transport-parity coverage for the in-process MCP dispatch.
 *
 * The parity suite is the load-bearing half: every behavior class a
 * collapsed handler can exhibit (schema-validated success, in-handler
 * problem+json error, thrown error, query-string read, multipart upload)
 * runs through BOTH transports — a real `node:http` listener and
 * `createLocalApiDispatch` — and the (status, body) pair must match
 * byte-for-byte, modulo the per-response `instance` correlation UUID.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BridgeMergeContentLossError } from '@inkeep/open-knowledge-core';
import busboy from 'busboy';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { catchErrors } from './catch-errors.ts';
import { errorResponse } from './error-response.ts';
import { createLocalApiDispatch, type LocalApiDispatch } from './local-api-dispatch.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

const EchoSuccessSchema = z.looseObject({ echoed: z.unknown() });
const QuerySuccessSchema = z.looseObject({ q: z.string().nullable() });
const UploadSuccessSchema = z.looseObject({ field: z.string(), fileBytes: z.number() });

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

const handlers: Record<string, Handler> = {
  '/api/echo': withValidation(
    z.looseObject({ value: z.string() }),
    catchErrors(
      async (_req, res, body) => {
        successResponse(res, 200, EchoSuccessSchema, { echoed: body.value }, { handler: 'echo' });
      },
      { handler: 'echo', title: 'Failed to echo.' },
    ),
    { handler: 'echo', method: 'POST' },
  ),
  '/api/query': withValidation(
    z.looseObject({}),
    catchErrors(
      async (req, res) => {
        const url = new URL(req.url ?? '', 'http://localhost');
        successResponse(
          res,
          200,
          QuerySuccessSchema,
          { q: url.searchParams.get('q') },
          { handler: 'query' },
        );
      },
      { handler: 'query', title: 'Failed to query.' },
    ),
    { handler: 'query', method: 'GET', skipBodyParse: true },
  ),
  '/api/reject': withValidation(
    z.looseObject({}),
    catchErrors(
      async (_req, res) => {
        errorResponse(res, 404, 'urn:ok:error:doc-not-found', 'No such thing.', {
          handler: 'reject',
          detail: 'It is simply not there.',
        });
      },
      { handler: 'reject', title: 'Failed to reject.' },
    ),
    { handler: 'reject', method: 'POST' },
  ),
  '/api/throw': withValidation(
    z.looseObject({}),
    catchErrors(
      async () => {
        throw new Error('boom');
      },
      { handler: 'throw', title: 'Failed to compute.' },
    ),
    { handler: 'throw', method: 'POST' },
  ),
  // Throws OUTSIDE any catchErrors boundary — exercises the dispatch's own
  // last-resort envelope (HTTP side: the listener wrapper below mirrors the
  // admission pipeline's catch).
  '/api/throw-raw': async () => {
    throw new Error('raw-boom');
  },
  '/api/upload-lite': (req, res) =>
    new Promise<void>((resolve) => {
      const bb = busboy({ headers: req.headers });
      let field = '';
      let fileBytes = 0;
      bb.on('field', (name, value) => {
        if (name === 'field') field = value;
      });
      bb.on('file', (_name, stream) => {
        stream.on('data', (chunk: Buffer) => {
          fileBytes += chunk.length;
        });
        stream.on('close', () => {});
      });
      bb.on('close', () => {
        successResponse(
          res,
          200,
          UploadSuccessSchema,
          { field, fileBytes },
          { handler: 'upload-lite' },
        );
        resolve();
      });
      req.pipe(bb);
    }),
};

const resolveHandler = (pathname: string): Handler | undefined => handlers[pathname];

const local: LocalApiDispatch = createLocalApiDispatch({ resolve: resolveHandler });

// Real listener over the same handlers, with the admission pipeline's
// last-resort catch semantics (500 envelope on an escaped throw).
const server = createServer((req, res) => {
  const pathname = (req.url ?? '/').split('?')[0] ?? '/';
  const handler = resolveHandler(pathname);
  if (!handler) {
    res.statusCode = 404;
    res.end('not found');
    return;
  }
  void (async () => {
    try {
      await handler(req, res);
    } catch (err) {
      if (!res.headersSent && !res.writableEnded && !res.destroyed) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: pathname,
          cause: err,
        });
      }
    }
  })();
});
const port = await new Promise<number>((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    resolve((server.address() as AddressInfo).port);
  });
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

/** Strip the per-response `instance` UUID so bodies compare stably. */
function comparable(bodyText: string): unknown {
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const { instance: _instance, ...rest } = parsed;
    return rest;
  } catch {
    return bodyText;
  }
}

async function overHttp(
  method: string,
  path: string,
  body?: string | Uint8Array,
  contentType?: string,
): Promise<{ status: number; bodyText: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: contentType !== undefined ? { 'content-type': contentType } : undefined,
    body,
  });
  return { status: res.status, bodyText: await res.text() };
}

describe('createLocalApiDispatch', () => {
  it('returns null for paths outside the resolver allowlist', async () => {
    expect(await local('GET', '/api/not-collapsed')).toBeNull();
  });

  it('strips the query string before resolving but hands it to the handler', async () => {
    const result = await local('GET', '/api/query?q=hello%20there');
    expect(result).not.toBeNull();
    expect(result?.status).toBe(200);
    expect(JSON.parse(result?.bodyText ?? '')).toEqual({ q: 'hello there' });
  });

  it('BridgeMergeContentLossError becomes the same 500 envelope, not a rejection', async () => {
    // The dispatch is the transport's terminal response boundary — like the
    // admission pipeline it envelopes the escape (cause-logged), and unlike
    // the pipeline it has no request-logging layer above to re-throw into.
    // Pin that the caller sees the standard envelope, never the raw error.
    const lossErr = new BridgeMergeContentLossError({
      which: 'merged',
      side: 'local',
      lostSubstrings: ['lost content'],
    } as ConstructorParameters<typeof BridgeMergeContentLossError>[0]);
    const lossy = createLocalApiDispatch({
      resolve: () => async () => {
        throw lossErr;
      },
    });
    const result = await lossy('POST', '/api/anything', {
      body: '{}',
      contentType: 'application/json',
    });
    expect(result?.status).toBe(500);
    expect(JSON.parse(result?.bodyText ?? '')).toMatchObject({
      type: 'urn:ok:error:internal-server-error',
      title: 'Internal server error.',
    });
  });

  it('rejects with the fetch-parity TimeoutError when the handler never responds', async () => {
    const hanging = createLocalApiDispatch({
      resolve: () => async () => {
        await new Promise(() => {});
      },
      timeoutMs: 50,
    });
    await expect(hanging('GET', '/api/anything')).rejects.toMatchObject({
      name: 'TimeoutError',
      message: 'The operation was aborted due to timeout',
    });
  });

  describe('transport parity (local vs real HTTP listener, same handlers)', () => {
    it('schema-validated success body', async () => {
      const body = JSON.stringify({ value: 'parity' });
      const viaHttp = await overHttp('POST', '/api/echo', body, 'application/json');
      const viaLocal = await local('POST', '/api/echo', { body, contentType: 'application/json' });
      expect(viaHttp.status).toBe(200);
      expect(viaLocal?.status).toBe(viaHttp.status);
      expect(comparable(viaLocal?.bodyText ?? '')).toEqual(comparable(viaHttp.bodyText));
    });

    it('request-validation 400 (schema mismatch, field-path detail)', async () => {
      const body = JSON.stringify({ value: 42 });
      const viaHttp = await overHttp('POST', '/api/echo', body, 'application/json');
      const viaLocal = await local('POST', '/api/echo', { body, contentType: 'application/json' });
      expect(viaHttp.status).toBe(400);
      expect(viaLocal?.status).toBe(400);
      expect(comparable(viaLocal?.bodyText ?? '')).toEqual(comparable(viaHttp.bodyText));
    });

    it('method mismatch 405', async () => {
      const viaHttp = await overHttp('GET', '/api/echo');
      const viaLocal = await local('GET', '/api/echo');
      expect(viaHttp.status).toBe(405);
      expect(viaLocal?.status).toBe(405);
      expect(comparable(viaLocal?.bodyText ?? '')).toEqual(comparable(viaHttp.bodyText));
    });

    it('in-handler problem+json error with detail', async () => {
      const viaHttp = await overHttp('POST', '/api/reject', '{}', 'application/json');
      const viaLocal = await local('POST', '/api/reject', {
        body: '{}',
        contentType: 'application/json',
      });
      expect(viaHttp.status).toBe(404);
      expect(viaLocal?.status).toBe(404);
      expect(comparable(viaLocal?.bodyText ?? '')).toEqual(comparable(viaHttp.bodyText));
    });

    it('throw inside catchErrors → per-handler 500 title', async () => {
      const viaHttp = await overHttp('POST', '/api/throw', '{}', 'application/json');
      const viaLocal = await local('POST', '/api/throw', {
        body: '{}',
        contentType: 'application/json',
      });
      expect(viaHttp.status).toBe(500);
      expect(viaLocal?.status).toBe(500);
      expect(comparable(viaLocal?.bodyText ?? '')).toEqual(comparable(viaHttp.bodyText));
      expect(JSON.parse(viaLocal?.bodyText ?? '')).toMatchObject({ title: 'Failed to compute.' });
    });

    it('throw that escapes the handler → last-resort 500 envelope', async () => {
      const viaHttp = await overHttp('POST', '/api/throw-raw', '{}', 'application/json');
      const viaLocal = await local('POST', '/api/throw-raw', {
        body: '{}',
        contentType: 'application/json',
      });
      expect(viaHttp.status).toBe(500);
      expect(viaLocal?.status).toBe(500);
      expect(comparable(viaLocal?.bodyText ?? '')).toEqual(comparable(viaHttp.bodyText));
      expect(JSON.parse(viaLocal?.bodyText ?? '')).toMatchObject({
        title: 'Internal server error.',
      });
    });

    it('multipart body reaches busboy identically', async () => {
      const form = new FormData();
      form.append('field', 'hello');
      form.append('file', new Blob([new Uint8Array(1024).fill(7)]), 'blob.bin');
      const encoded = new Request('http://localhost/api/upload-lite', {
        method: 'POST',
        body: form,
      });
      const contentType = encoded.headers.get('content-type') ?? '';
      const bytes = new Uint8Array(await encoded.arrayBuffer());

      const viaHttp = await overHttp('POST', '/api/upload-lite', bytes, contentType);
      const viaLocal = await local('POST', '/api/upload-lite', { body: bytes, contentType });
      expect(viaHttp.status).toBe(200);
      expect(viaLocal?.status).toBe(200);
      expect(comparable(viaLocal?.bodyText ?? '')).toEqual(comparable(viaHttp.bodyText));
      expect(JSON.parse(viaLocal?.bodyText ?? '')).toEqual({ field: 'hello', fileBytes: 1024 });
    });
  });
});
