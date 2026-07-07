import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { Extension, Hocuspocus } from '@hocuspocus/server';
import {
  captureServerMemorySnapshot,
  installPerfMeasurementHttpRoute,
  PERF_SERVER_MEMORY_ROUTE,
  type ServerMemorySnapshot,
} from './perf-measurement.ts';

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function makeReq(
  method: string,
  url: string,
  opts: { remoteAddress?: string; host?: string } = {},
): IncomingMessage {
  const readable = Readable.from(Buffer.from('')) as unknown as IncomingMessage;
  readable.method = method;
  readable.url = url;
  readable.headers = { host: opts.host ?? 'localhost' };
  // The defense-in-depth guards in the route read `request.socket?.remoteAddress`
  // (loopback gate) + `request.headers.host` (Host-header gate). Tests default
  // to a loopback peer + localhost Host so the existing happy-path assertions
  // continue to exercise the 200 branch; the negative-case tests below pass
  // explicit non-loopback values via `opts.remoteAddress` / `opts.host`.
  (readable as unknown as { socket: { remoteAddress: string } }).socket = {
    remoteAddress: opts.remoteAddress ?? '127.0.0.1',
  };
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

interface HocuspocusStub {
  configuration: { extensions: Extension[] };
}

function makeHocuspocusStub(): HocuspocusStub {
  return { configuration: { extensions: [] } };
}

async function invokeExtensionOnRequest(
  extension: Extension,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const hook = extension.onRequest;
  if (typeof hook !== 'function') {
    throw new Error('extension does not implement onRequest');
  }
  // Hocuspocus passes `{ request, response }` per its onRequest signature.
  // The pushed extension is a plain object literal — no `this` binding required.
  await (
    hook as (payload: { request: IncomingMessage; response: ServerResponse }) => Promise<void>
  )({ request, response });
}

// Save + restore the two env vars this module reads so individual tests can
// flip them without leaking into the next test in the file. The typed
// `process.env` declares `NODE_ENV` as a readonly named property, so writes
// go through this mutable structural view rather than scattering casts at
// every assignment site.
const ENV_KEYS = ['NODE_ENV', 'OK_PERF_SERVER_MEMORY_ENABLED'] as const;
type MutableEnv = Record<string, string | undefined>;
const env = process.env as MutableEnv;

describe('captureServerMemorySnapshot', () => {
  test('returns schemaVersion=1, ISO timestamp, and positive MB for all 5 fields', () => {
    const snap: ServerMemorySnapshot = captureServerMemorySnapshot();

    expect(snap.schemaVersion).toBe(1);
    expect(typeof snap.capturedAt).toBe('string');
    // ISO8601 round-trip survives Date parsing.
    expect(new Date(snap.capturedAt).toISOString()).toBe(snap.capturedAt);

    expect(snap.snapshot.rssMb).toBeGreaterThan(0);
    expect(snap.snapshot.heapTotalMb).toBeGreaterThan(0);
    expect(snap.snapshot.heapUsedMb).toBeGreaterThan(0);
    expect(snap.snapshot.externalMb).toBeGreaterThanOrEqual(0);
    expect(snap.snapshot.arrayBuffersMb).toBeGreaterThanOrEqual(0);

    // No assertion on heapUsed vs heapTotal: that's a V8 GC-bookkeeping
    // invariant. Bun's JSC backend synthesizes these from a heap-walker
    // rather than GC bookkeeping, and heapUsed can legitimately exceed
    // heapTotal under JSC. The sweep-harness consumer reads both as raw
    // observations and never compares them.
  });

  test('two successive captures produce monotonically-non-decreasing timestamps', () => {
    const before = captureServerMemorySnapshot().capturedAt;
    // Force a fresh Date.now() — tiny sleep without test flake. Tests run on
    // ms-resolution timestamps; two calls in the same ms is fine (>= holds).
    const after = captureServerMemorySnapshot().capturedAt;
    expect(after >= before).toBe(true);
  });
});

describe('installPerfMeasurementHttpRoute', () => {
  const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) originalEnv[key] = env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete env[key];
      else env[key] = originalEnv[key];
    }
  });

  test('pushes exactly one Extension onto hocuspocus.configuration.extensions', () => {
    const stub = makeHocuspocusStub();
    installPerfMeasurementHttpRoute(stub as unknown as Hocuspocus);
    expect(stub.configuration.extensions).toHaveLength(1);
    const ext = stub.configuration.extensions[0];
    expect(ext).toBeDefined();
    expect(typeof ext?.onRequest).toBe('function');
  });

  test('GET /__ok_perf/server-memory with env=true + NODE_ENV=development returns 200 + structured JSON', async () => {
    env.NODE_ENV = 'development';
    env.OK_PERF_SERVER_MEMORY_ENABLED = 'true';
    const stub = makeHocuspocusStub();
    installPerfMeasurementHttpRoute(stub as unknown as Hocuspocus);
    const extension = stub.configuration.extensions[0];
    expect(extension).toBeDefined();
    if (!extension) return;

    const { res, captured } = makeRes();
    await invokeExtensionOnRequest(extension, makeReq('GET', PERF_SERVER_MEMORY_ROUTE), res);

    expect(captured.status).toBe(200);
    expect(captured.headers['Content-Type']).toBe('application/json');
    // Defense-in-depth headers — match the package's canonical response
    // helpers so live process-memory telemetry can't be MIME-sniffed by a
    // browser or cached stale by an intermediate proxy.
    expect(captured.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(captured.headers['Cache-Control']).toBe('no-store');
    const body = JSON.parse(captured.body) as ServerMemorySnapshot;
    expect(body.schemaVersion).toBe(1);
    expect(typeof body.capturedAt).toBe('string');
    expect(new Date(body.capturedAt).toISOString()).toBe(body.capturedAt);
    expect(body.snapshot.rssMb).toBeGreaterThan(0);
    expect(body.snapshot.heapTotalMb).toBeGreaterThan(0);
    expect(body.snapshot.heapUsedMb).toBeGreaterThan(0);
    expect(body.snapshot.externalMb).toBeGreaterThanOrEqual(0);
    expect(body.snapshot.arrayBuffersMb).toBeGreaterThanOrEqual(0);
  });

  test('GET with NODE_ENV undefined returns 404 (Bun fail-closed contract)', async () => {
    // Bun does not default NODE_ENV to anything; `process.env.NODE_ENV` is
    // `undefined` unless explicitly set. The gate must fail closed —
    // `!== 'production'` would treat undefined as production-safe and let
    // the route through; the affirmative `=== 'development' || === 'test'`
    // check rejects undefined as it does production.
    delete env.NODE_ENV;
    env.OK_PERF_SERVER_MEMORY_ENABLED = 'true';
    const stub = makeHocuspocusStub();
    installPerfMeasurementHttpRoute(stub as unknown as Hocuspocus);
    const extension = stub.configuration.extensions[0];
    expect(extension).toBeDefined();
    if (!extension) return;

    const { res, captured } = makeRes();
    await invokeExtensionOnRequest(extension, makeReq('GET', PERF_SERVER_MEMORY_ROUTE), res);

    expect(captured.status).toBe(404);
    expect(JSON.parse(captured.body)).toEqual({ error: 'route disabled' });
  });

  test('GET with OK_PERF_SERVER_MEMORY_ENABLED unset returns 404 (not 403, not 200)', async () => {
    env.NODE_ENV = 'development';
    delete env.OK_PERF_SERVER_MEMORY_ENABLED;
    const stub = makeHocuspocusStub();
    installPerfMeasurementHttpRoute(stub as unknown as Hocuspocus);
    const extension = stub.configuration.extensions[0];
    expect(extension).toBeDefined();
    if (!extension) return;

    const { res, captured } = makeRes();
    await invokeExtensionOnRequest(extension, makeReq('GET', PERF_SERVER_MEMORY_ROUTE), res);

    expect(captured.status).toBe(404);
    // Minimal JSON body — strict consumers (`await res.json()`) parse cleanly
    // and see "route disabled" instead of throwing on empty input under the
    // application/json Content-Type.
    expect(JSON.parse(captured.body)).toEqual({ error: 'route disabled' });
  });

  test('GET with NODE_ENV=production returns 404 even when env var is set', async () => {
    env.NODE_ENV = 'production';
    env.OK_PERF_SERVER_MEMORY_ENABLED = 'true';
    const stub = makeHocuspocusStub();
    installPerfMeasurementHttpRoute(stub as unknown as Hocuspocus);
    const extension = stub.configuration.extensions[0];
    expect(extension).toBeDefined();
    if (!extension) return;

    const { res, captured } = makeRes();
    await invokeExtensionOnRequest(extension, makeReq('GET', PERF_SERVER_MEMORY_ROUTE), res);

    expect(captured.status).toBe(404);
    expect(JSON.parse(captured.body)).toEqual({ error: 'route disabled' });
  });

  test('GET with OK_PERF_SERVER_MEMORY_ENABLED=false (string) returns 404', async () => {
    env.NODE_ENV = 'development';
    env.OK_PERF_SERVER_MEMORY_ENABLED = 'false';
    const stub = makeHocuspocusStub();
    installPerfMeasurementHttpRoute(stub as unknown as Hocuspocus);
    const extension = stub.configuration.extensions[0];
    expect(extension).toBeDefined();
    if (!extension) return;

    const { res, captured } = makeRes();
    await invokeExtensionOnRequest(extension, makeReq('GET', PERF_SERVER_MEMORY_ROUTE), res);

    // Only the literal string "true" enables the route. Any other value reads
    // as disabled — leaves no ambiguity for operators copy-pasting from docs.
    expect(captured.status).toBe(404);
  });

  test('GET on an unrelated URL is a silent no-op (falls through to next extension)', async () => {
    env.NODE_ENV = 'development';
    env.OK_PERF_SERVER_MEMORY_ENABLED = 'true';
    const stub = makeHocuspocusStub();
    installPerfMeasurementHttpRoute(stub as unknown as Hocuspocus);
    const extension = stub.configuration.extensions[0];
    expect(extension).toBeDefined();
    if (!extension) return;

    const { res, captured } = makeRes();
    await invokeExtensionOnRequest(extension, makeReq('GET', '/api/pages'), res);

    // captured.status stays at 0 (the mock initial value) — neither writeHead
    // nor end was called. This is the "silent fallthrough" contract.
    expect(captured.status).toBe(0);
    expect(captured.body).toBe('');
  });

  test('non-GET on the perf route is a silent no-op (404 is reserved for disabled state)', async () => {
    env.NODE_ENV = 'development';
    env.OK_PERF_SERVER_MEMORY_ENABLED = 'true';
    const stub = makeHocuspocusStub();
    installPerfMeasurementHttpRoute(stub as unknown as Hocuspocus);
    const extension = stub.configuration.extensions[0];
    expect(extension).toBeDefined();
    if (!extension) return;

    const { res, captured } = makeRes();
    await invokeExtensionOnRequest(extension, makeReq('POST', PERF_SERVER_MEMORY_ROUTE), res);

    // Route only owns GET. Non-GET is not "disabled" — it's an unrecognized
    // method, and the extension stays out of the way so downstream handlers
    // can decide. (Hocuspocus's catch-all middleware returns 404 for the
    // entire URL+method combination anyway in production.)
    expect(captured.status).toBe(0);
    expect(captured.body).toBe('');
  });

  test('PERF_SERVER_MEMORY_ROUTE is the canonical "__ok_perf" path', () => {
    expect(PERF_SERVER_MEMORY_ROUTE).toBe('/__ok_perf/server-memory');
  });

  test('GET on perf route with query string still matches (?cell=42 etc.)', async () => {
    env.NODE_ENV = 'development';
    env.OK_PERF_SERVER_MEMORY_ENABLED = 'true';
    const stub = makeHocuspocusStub();
    installPerfMeasurementHttpRoute(stub as unknown as Hocuspocus);
    const extension = stub.configuration.extensions[0];
    expect(extension).toBeDefined();
    if (!extension) return;

    const { res, captured } = makeRes();
    await invokeExtensionOnRequest(
      extension,
      makeReq('GET', `${PERF_SERVER_MEMORY_ROUTE}?cell=42`),
      res,
    );

    // The sweep harness will tag scrapes with a per-cell query so the server
    // log line can be correlated to the cell index. Query strings must not
    // break URL matching.
    expect(captured.status).toBe(200);
    const body = JSON.parse(captured.body) as ServerMemorySnapshot;
    expect(body.schemaVersion).toBe(1);
  });

  test('GET from a non-loopback peer returns 403 even when DEV gates pass', async () => {
    env.NODE_ENV = 'development';
    env.OK_PERF_SERVER_MEMORY_ENABLED = 'true';
    const stub = makeHocuspocusStub();
    installPerfMeasurementHttpRoute(stub as unknown as Hocuspocus);
    const extension = stub.configuration.extensions[0];
    expect(extension).toBeDefined();
    if (!extension) return;

    const { res, captured } = makeRes();
    await invokeExtensionOnRequest(
      extension,
      // A LAN-peer address — the route must refuse even when both DEV gates
      // pass. The information-disclosure surface is low (rss/heap MB) but
      // the defense-in-depth posture matches /api/principal + /api/workspace.
      makeReq('GET', PERF_SERVER_MEMORY_ROUTE, { remoteAddress: '192.168.1.10' }),
      res,
    );

    expect(captured.status).toBe(403);
    expect(JSON.parse(captured.body)).toEqual({ error: 'loopback required' });
  });

  test('GET from loopback with a non-localhost Host header returns 403 (DNS-rebinding defense)', async () => {
    env.NODE_ENV = 'development';
    env.OK_PERF_SERVER_MEMORY_ENABLED = 'true';
    const stub = makeHocuspocusStub();
    installPerfMeasurementHttpRoute(stub as unknown as Hocuspocus);
    const extension = stub.configuration.extensions[0];
    expect(extension).toBeDefined();
    if (!extension) return;

    const { res, captured } = makeRes();
    await invokeExtensionOnRequest(
      extension,
      // Loopback peer but an attacker-controlled Host header. The
      // DNS-rebinding playbook requires us to refuse — otherwise a
      // malicious page whose hostname was rebound to 127.0.0.1 after the
      // browser fetched its JS could scrape this route.
      makeReq('GET', PERF_SERVER_MEMORY_ROUTE, { host: 'evil.example.com' }),
      res,
    );

    expect(captured.status).toBe(403);
    expect(JSON.parse(captured.body)).toEqual({ error: 'host header not allowed' });
  });
});
