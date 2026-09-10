import { createReadStream, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { ATTR_ERROR_TYPE } from '@opentelemetry/semantic-conventions';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { buildIngressPolicy } from '../ingress-policy.ts';
import { loggerFactory } from '../logger.ts';
import { listenOnLoopback } from '../loopback-rig-test-helpers.ts';
import { createAssetService } from '../services/assets.ts';
import { createApiRequestPipeline } from './api-pipeline.ts';
import { createAssetRoutes } from './asset-routes.ts';
import { createContentDispatch } from './content-dispatch.ts';
import { createHttpApp } from './http-app.ts';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, createReadStream: vi.fn(fs.createReadStream) };
});

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
});

async function expectTransferSpan(status: SpanStatusCode, errorType: string | undefined) {
  await vi.waitFor(() => {
    const span = exporter.getFinishedSpans().find((entry) => entry.name === 'HTTP GET /api/asset');
    expect(span).toBeDefined();
    expect(span?.status.code).toBe(status);
    expect(span?.attributes[ATTR_ERROR_TYPE]).toBe(errorType);
    expect(span?.attributes['http.response.status_code']).toBe(200);
    expect(span?.events.some((event) => event.name === 'exception')).toBe(
      status === SpanStatusCode.ERROR,
    );
  });
}

let root: string;
let server: Server | undefined;

async function start() {
  root = mkdtempSync(resolve(tmpdir(), 'ok-asset-stream-'));
  mkdirSync(resolve(root, 'docs'));
  const file = resolve(root, 'docs', 'large.png');
  writeFileSync(file, Buffer.alloc(8_000_000, 97));
  const log = loggerFactory.getLogger('asset-stream-test');
  const logError = vi.spyOn(log, 'error');
  const group = createAssetRoutes({ assetService: createAssetService({ contentDir: root }), log });
  const legacy = vi.fn(
    (_req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
      res.end('legacy sentinel');
    },
  );
  const app = createHttpApp({
    log,
    legacyDispatch: legacy,
    contentDispatch: createContentDispatch({ ingressPolicy: buildIngressPolicy({}), log }),
    nativeApi: {
      paths: group.paths,
      dispatch: createApiRequestPipeline({
        log,
        policy: buildIngressPolicy({}),
        table: group.table,
      }),
    },
  });
  server = createServer(app.requestListener);
  const { port } = await listenOnLoopback(server);
  return { port, file, legacy, logError };
}

afterEach(async () => {
  vi.mocked(createReadStream).mockReset();
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(createReadStream).mockImplementation(fs.createReadStream);
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolveClosed, reject) =>
      server?.close((error) => (error ? reject(error) : resolveClosed())),
    );
    server = undefined;
  }
  if (root) await rm(root, { recursive: true, force: true });
  await provider.shutdown();
  trace.disable();
  context.disable();
  vi.restoreAllMocks();
});

describe('native asset raw stream lifetime over HTTP', () => {
  test('a complete transfer leaves the HTTP span successful', async () => {
    const { port, legacy } = await start();
    const response = await fetch(`http://127.0.0.1:${port}/api/asset?path=docs/large.png`);
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(8_000_000);
    await expectTransferSpan(SpanStatusCode.UNSET, undefined);
    expect(legacy).not.toHaveBeenCalled();
  });

  test('a file disappearing after resolution aborts the socket without a JSON or SPA fallback', async () => {
    const { port, legacy } = await start();
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(createReadStream).mockImplementationOnce((path) => {
      fs.unlinkSync(path);
      return fs.createReadStream(path);
    });
    const outcome = await new Promise<{ body: string; aborted: boolean }>((resolveOutcome) => {
      const req = request(
        { hostname: '127.0.0.1', port, path: '/api/asset?path=docs/large.png' },
        (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += String(chunk);
          });
          res.on('aborted', () => resolveOutcome({ body, aborted: true }));
          res.on('error', () => resolveOutcome({ body, aborted: true }));
          res.on('end', () => resolveOutcome({ body, aborted: false }));
        },
      );
      req.on('error', () => resolveOutcome({ body: '', aborted: true }));
      req.end();
    });
    expect(outcome).toEqual({ body: '', aborted: true });
    expect(legacy).not.toHaveBeenCalled();
    await expectTransferSpan(SpanStatusCode.ERROR, 'stream_failure');
  });

  test('a source failure after bytes arrive leaves only the original binary prefix', async () => {
    const { port, file, legacy } = await start();
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const stream = fs.createReadStream(file, { highWaterMark: 4096 });
    stream.pause();
    stream.once('data', () => stream.pause());
    vi.mocked(createReadStream).mockReturnValueOnce(stream);
    const response = await new Promise<{
      bytes: Buffer;
      aborted: boolean;
      contentType: string | undefined;
    }>((resolveResponse, reject) => {
      const req = request(
        { hostname: '127.0.0.1', port, path: '/api/asset?path=docs/large.png' },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
            stream.destroy(new Error('injected disk read failure'));
          });
          res.on('error', reject);
          res.on('aborted', () =>
            resolveResponse({
              bytes: Buffer.concat(chunks),
              aborted: true,
              contentType: res.headers['content-type'],
            }),
          );
          res.on('end', () =>
            resolveResponse({
              bytes: Buffer.concat(chunks),
              aborted: false,
              contentType: res.headers['content-type'],
            }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(response.aborted).toBe(true);
    expect(response.contentType).toBe('image/png');
    expect(response.bytes.length).toBeGreaterThan(0);
    expect(response.bytes.length).toBeLessThan(8_000_000);
    expect(response.bytes.equals(Buffer.alloc(response.bytes.length, 97))).toBe(true);
    expect(legacy).not.toHaveBeenCalled();
    await expectTransferSpan(SpanStatusCode.ERROR, 'stream_failure');
  });

  test.each(['destroy', 'resetAndDestroy'] as const)(
    'client %s destroys the file stream and does not enter legacy dispatch',
    async (disconnect) => {
      const { port, file, legacy, logError } = await start();
      const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
      let streamClosed: Promise<unknown> | undefined;
      vi.mocked(createReadStream).mockImplementationOnce(() => {
        const stream = fs.createReadStream(file, { highWaterMark: 4096 });
        streamClosed = new Promise<void>((resolveClosed) => stream.once('close', resolveClosed));
        return stream;
      });
      await new Promise<void>((resolveAborted, reject) => {
        const req = request(
          { hostname: '127.0.0.1', port, path: '/api/asset?path=docs/large.png' },
          (res) => {
            res.once('data', () => {
              if (disconnect === 'resetAndDestroy') res.socket.resetAndDestroy();
              else res.destroy();
              resolveAborted();
            });
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(streamClosed).toBeDefined();
      await streamClosed;
      expect(legacy).not.toHaveBeenCalled();
      await expectTransferSpan(SpanStatusCode.ERROR, 'connection_closed');
      expect(logError).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'api.asset.pipeline-failed',
          err: expect.objectContaining({ code: 'ERR_STREAM_PREMATURE_CLOSE' }),
        }),
        '[asset] pipeline failed mid-stream',
      );
    },
  );

  test.each(['EPIPE', 'ECONNRESET'])(
    'a destination %s retains the binary prefix and records connection closure',
    async (code) => {
      const { port, file, legacy, logError } = await start();
      const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
      const stream = fs.createReadStream(file, { highWaterMark: 4096 });
      stream.once('data', () => stream.pause());
      vi.mocked(createReadStream).mockReturnValueOnce(stream);
      let response: import('node:http').ServerResponse | undefined;
      server?.once('request', (_req, res) => {
        response = res;
      });
      const bytes = await new Promise<Buffer>((resolveAborted, reject) => {
        const req = request(
          { hostname: '127.0.0.1', port, path: '/api/asset?path=docs/large.png' },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => {
              chunks.push(chunk);
              response?.emit(
                'error',
                Object.assign(new Error('injected destination failure'), { code }),
              );
            });
            res.on('aborted', () => resolveAborted(Buffer.concat(chunks)));
            res.on('error', reject);
            res.on('end', () => reject(new Error('transfer unexpectedly completed')));
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(bytes.length).toBeGreaterThan(0);
      expect(bytes.length).toBeLessThan(8_000_000);
      expect(bytes.equals(Buffer.alloc(bytes.length, 97))).toBe(true);
      await expectTransferSpan(SpanStatusCode.ERROR, 'connection_closed');
      expect(logError).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'api.asset.pipeline-failed',
          err: expect.objectContaining({ code }),
        }),
        '[asset] pipeline failed mid-stream',
      );
      expect(legacy).not.toHaveBeenCalled();
    },
  );
});
