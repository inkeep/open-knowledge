import { createServer } from 'node:http';
import { describe, expect, test } from 'vitest';
import { parseProblem, rawRequest } from '../composition-rig.test-helper.ts';
import { buildIngressPolicy } from '../ingress-policy.ts';
import { listenOnLoopback } from '../loopback-rig-test-helpers.ts';
import {
  type ApiRouteTable,
  createApiRequestPipeline,
  createApiRouteGroup,
} from './api-pipeline.ts';
import { createContentDispatch } from './content-dispatch.ts';
import { createHttpApp, type NativeApiHandle } from './http-app.ts';

const fakeLog = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => fakeLog,
} as never;

const EXPECTED_ALLOW_HEADERS =
  'Content-Type, Authorization, traceparent, tracestate, baggage, x-request-id, x-ok-client-protocol, x-ok-client-runtime, x-ok-client-kind';

interface NativeRig {
  port: number;
  baseUrl: string;
  legacyCalls: string[];
  dispatched: string[];
  close: () => Promise<void>;
}

async function bootNativeRig(opts: { ephemeral?: boolean } = {}): Promise<NativeRig> {
  const legacyCalls: string[] = [];
  const dispatched: string[] = [];
  const table: ApiRouteTable = {
    resolve(pathname) {
      if (
        pathname === '/api/native-ping' ||
        pathname === '/api/agent-write-md' ||
        pathname === '/api/native-mutating' ||
        pathname === '/api/native-upload'
      ) {
        return {
          template: pathname,
          dispatch: async (req, res) => {
            dispatched.push(`${req.method} ${pathname}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ pong: true }));
          },
        };
      }
      if (pathname === '/api/native-revalidated') {
        return {
          template: pathname,
          dispatch: async (_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
            res.end('{}');
          },
        };
      }
      if (pathname === '/api/native-throw') {
        return {
          template: pathname,
          dispatch: async () => {
            throw new Error('handler boom');
          },
        };
      }
      if (pathname === '/api/native-empty') {
        return { template: '/api/native-empty' };
      }
      return null;
    },
    isMutating: (pathname) =>
      pathname === '/api/native-mutating' || pathname === '/api/agent-write-md',
  };
  const nativeApi: NativeApiHandle = {
    paths: [
      '/api/native-ping',
      '/api/agent-write-md',
      '/api/native-mutating',
      '/api/native-upload',
      '/api/native-revalidated',
      '/api/native-throw',
      '/api/native-empty',
      '/api/native-declined',
    ],
    dispatch: createApiRequestPipeline({
      log: fakeLog,
      ephemeral: opts.ephemeral,
      table,
    }),
  };
  const { requestListener } = createHttpApp({
    nativeApi,
    contentDispatch: createContentDispatch({ ingressPolicy: buildIngressPolicy({}), log: fakeLog }),
    legacyDispatch: (req, res) => {
      legacyCalls.push(req.url ?? '');
      res.writeHead(299, { 'Content-Type': 'text/plain' });
      res.end('legacy');
    },
    log: fakeLog,
  });
  const server = createServer(requestListener);
  const { port, baseUrl } = await listenOnLoopback(server);
  return {
    port,
    baseUrl,
    legacyCalls,
    dispatched,
    close: () =>
      new Promise<void>((resolvePromise, reject) => {
        server.close((err) => (err ? reject(err) : resolvePromise()));
      }),
  };
}

describe('natively-mounted /api routes run the shared admission pipeline', () => {
  test('a claimed route is served natively — the legacy dispatch never sees it', async () => {
    const rig = await bootNativeRig();
    try {
      const res = await fetch(`${rig.baseUrl}/api/native-ping`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ pong: true });
      expect(rig.legacyCalls).toEqual([]);
    } finally {
      await rig.close();
    }
  });

  test('an unclaimed route still flows through the legacy dispatch', async () => {
    const rig = await bootNativeRig();
    try {
      const res = await fetch(`${rig.baseUrl}/api/anything-else`);
      expect(res.status).toBe(299);
      expect(rig.legacyCalls).toEqual(['/api/anything-else']);
    } finally {
      await rig.close();
    }
  });

  test('a claimed path the table declines falls through to the legacy dispatch', async () => {
    const rig = await bootNativeRig();
    try {
      const res = await fetch(`${rig.baseUrl}/api/native-declined`);
      expect(res.status).toBe(299);
      expect(rig.legacyCalls).toEqual(['/api/native-declined']);
      expect(res.headers.get('x-request-id')).toBeNull();
      expect(res.headers.get('access-control-allow-methods')).toBeNull();
    } finally {
      await rig.close();
    }
  });

  test('a declined path skips the gates too — foreign Origin falls through, not 403', async () => {
    const rig = await bootNativeRig();
    try {
      const res = await fetch(`${rig.baseUrl}/api/native-declined`, {
        headers: { Origin: 'https://evil.example' },
      });
      expect(res.status).toBe(299);
      expect(rig.legacyCalls).toEqual(['/api/native-declined']);
    } finally {
      await rig.close();
    }
  });

  test('a dot-segment URL the router normalizes onto a claimed path still gets a response', async () => {
    const rig = await bootNativeRig();
    try {
      const res = await rawRequest(rig.port, '/api/./native-ping', {});
      expect(res.status).toBe(299);
      expect(rig.legacyCalls).toEqual(['/api/./native-ping']);
    } finally {
      await rig.close();
    }
  });

  test('responses carry the x-request-id echo, honoring a well-formed inbound ID', async () => {
    const rig = await bootNativeRig();
    try {
      const minted = await fetch(`${rig.baseUrl}/api/native-ping`);
      expect(minted.headers.get('x-request-id')).toMatch(/^[A-Za-z0-9._-]{1,128}$/);

      const echoed = await fetch(`${rig.baseUrl}/api/native-ping`, {
        headers: { 'x-request-id': 'caller-chosen.id-42' },
      });
      expect(echoed.headers.get('x-request-id')).toBe('caller-chosen.id-42');
    } finally {
      await rig.close();
    }
  });

  test('API answers default to Cache-Control: no-store, refusals included', async () => {
    const rig = await bootNativeRig();
    try {
      const served = await fetch(`${rig.baseUrl}/api/native-ping`);
      expect(served.status).toBe(200);
      expect(served.headers.get('cache-control')).toBe('no-store');

      const refused = await fetch(`${rig.baseUrl}/api/native-ping`, {
        headers: { Origin: 'https://evil.example' },
      });
      expect(refused.status).toBe(403);
      expect(refused.headers.get('cache-control')).toBe('no-store');
    } finally {
      await rig.close();
    }
  });

  test('a route that names its own Cache-Control keeps it over the default', async () => {
    const rig = await bootNativeRig();
    try {
      const res = await fetch(`${rig.baseUrl}/api/native-revalidated`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-cache');
    } finally {
      await rig.close();
    }
  });

  test('a foreign Origin is refused before dispatch with the legacy problem shape', async () => {
    const rig = await bootNativeRig();
    try {
      const res = await fetch(`${rig.baseUrl}/api/native-ping`, {
        headers: { Origin: 'https://evil.example' },
      });
      expect(res.status).toBe(403);
      expect(res.headers.get('content-type')).toBe('application/problem+json');
      const body = (await res.json()) as { type?: string; title?: string; detail?: string };
      expect(body.type).toBe('urn:ok:error:invalid-origin');
      expect(body.title).toBe('Origin not allowed.');
      expect(body.detail).toBeUndefined();
      expect(res.headers.get('x-request-id')).not.toBeNull();
    } finally {
      await rig.close();
    }
  });

  test('an allowed browser Origin gets verbatim CORS reflection with the exact header list', async () => {
    const rig = await bootNativeRig();
    try {
      const res = await fetch(`${rig.baseUrl}/api/native-ping`, {
        headers: { Origin: 'http://localhost:5173' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
      expect(res.headers.get('vary')).toContain('Origin');
      expect(res.headers.get('access-control-allow-methods')).toBe(
        'GET, POST, PUT, DELETE, OPTIONS',
      );
      expect(res.headers.get('access-control-allow-headers')).toBe(EXPECTED_ALLOW_HEADERS);
      expect(res.headers.get('access-control-expose-headers')).toBe('x-request-id');
    } finally {
      await rig.close();
    }
  });

  test('OPTIONS preflight answers 204 with the CORS headers', async () => {
    const rig = await bootNativeRig();
    try {
      const res = await fetch(`${rig.baseUrl}/api/native-ping`, {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:5173' },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-methods')).toBe(
        'GET, POST, PUT, DELETE, OPTIONS',
      );
    } finally {
      await rig.close();
    }
  });

  test('any forwarding header trips the proxied-request refusal on a native route', async () => {
    const rig = await bootNativeRig();
    try {
      const res = await rawRequest(rig.port, '/api/native-ping', {
        headers: { 'X-Forwarded-For': '203.0.113.7' },
      });
      expect(res.status).toBe(403);
      const body = parseProblem(res.body);
      expect(body.type).toBe('urn:ok:error:host-not-allowed');
      expect(body.detail ?? body.title).toContain('Proxied request refused');
    } finally {
      await rig.close();
    }
  });

  test('native routes under a rebound Host are refused — mutating AND read', async () => {
    const rig = await bootNativeRig();
    try {
      const refused = await rawRequest(rig.port, '/api/native-mutating', {
        headers: { Host: 'evil.example' },
      });
      expect(refused.status).toBe(403);
      expect(parseProblem(refused.body).type).toBe('urn:ok:error:host-not-allowed');

      const read = await rawRequest(rig.port, '/api/native-ping', {
        headers: { Host: 'evil.example' },
      });
      expect(read.status).toBe(403);
      expect(parseProblem(read.body).type).toBe('urn:ok:error:host-not-allowed');

      const allowed = await rawRequest(rig.port, '/api/native-mutating', {
        headers: { Host: 'localhost' },
      });
      expect(allowed.status).toBe(200);
    } finally {
      await rig.close();
    }
  });

  test('ephemeral mode Host-gates EVERY native /api route, including reads', async () => {
    const rig = await bootNativeRig({ ephemeral: true });
    try {
      const refused = await rawRequest(rig.port, '/api/native-ping', {
        headers: { Host: 'evil.example' },
      });
      expect(refused.status).toBe(403);
      expect(parseProblem(refused.body).type).toBe('urn:ok:error:host-not-allowed');

      const allowed = await rawRequest(rig.port, '/api/native-ping', {
        headers: { Host: 'localhost' },
      });
      expect(allowed.status).toBe(200);
    } finally {
      await rig.close();
    }
  });

  test('previews reject project mutations while retaining document edits and reads', async () => {
    const rig = await bootNativeRig({ ephemeral: true });
    try {
      const blocked = await rawRequest(rig.port, '/api/native-mutating', { method: 'POST' });
      expect(blocked.status).toBe(403);
      expect(parseProblem(blocked.body).title).toBe(
        'Single-file previews cannot manage project files.',
      );
      const edit = await rawRequest(rig.port, '/api/agent-write-md', { method: 'POST' });
      expect(edit.status).toBe(200);
      const read = await rawRequest(rig.port, '/api/native-ping');
      expect(read.status).toBe(200);
      expect(rig.dispatched).toEqual(['POST /api/agent-write-md', 'GET /api/native-ping']);
    } finally {
      await rig.close();
    }
  });

  test('an owned URL with no handler gets the explicit RFC 9457 404', async () => {
    const rig = await bootNativeRig();
    try {
      const res = await fetch(`${rig.baseUrl}/api/native-empty`);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toBe('application/problem+json');
      const body = (await res.json()) as { type?: string; title?: string };
      expect(body.type).toBe('urn:ok:error:not-found');
      expect(body.title).toBe('API endpoint not found.');
      expect(rig.legacyCalls).toEqual([]);
    } finally {
      await rig.close();
    }
  });

  test('a throwing handler surfaces as the typed 500 envelope, not a reset', async () => {
    const rig = await bootNativeRig();
    try {
      const res = await fetch(`${rig.baseUrl}/api/native-throw`);
      expect(res.status).toBe(500);
      expect(res.headers.get('content-type')).toBe('application/problem+json');
      const body = (await res.json()) as { type?: string };
      expect(body.type).toBe('urn:ok:error:internal-server-error');
    } finally {
      await rig.close();
    }
  });
});

describe('opaque origins and request body media types', () => {
  const OPAQUE_ORIGINS = ['null', 'file://', 'file://127.0.0.1'];
  const FILE_ORIGINS = ['file://', 'file://127.0.0.1'];
  const OPAQUE_DETAIL =
    'Requests from a null origin, and writes from a file: origin, are refused. Send the request from a loopback page, the OpenKnowledge app, or a client that sends no Origin header.';

  function expectNoCorsGrant(headers: Record<string, string | string[] | undefined>): void {
    expect(headers['access-control-allow-origin']).toBeUndefined();
    expect(headers['access-control-allow-methods']).toBeUndefined();
    expect(headers['access-control-allow-headers']).toBeUndefined();
    expect(headers['access-control-expose-headers']).toBeUndefined();
  }

  test('a read from a null Origin is refused 403 before dispatch', async () => {
    const rig = await bootNativeRig();
    try {
      const res = await rawRequest(rig.port, '/api/native-ping', { headers: { Origin: 'null' } });
      expect(res.status).toBe(403);
      const problem = parseProblem(res.body);
      expect(problem.type).toBe('urn:ok:error:invalid-origin');
      expect(problem.detail).toBe(OPAQUE_DETAIL);
      expectNoCorsGrant(res.headers);
      expect(rig.dispatched).toEqual([]);
    } finally {
      await rig.close();
    }
  });

  test('a read from a file: Origin is served with no CORS grant, so a browser cannot read it', async () => {
    const rig = await bootNativeRig();
    try {
      for (const origin of FILE_ORIGINS) {
        const res = await rawRequest(rig.port, '/api/native-ping', { headers: { Origin: origin } });
        expect(res.status, origin).toBe(200);
        expectNoCorsGrant(res.headers);
        expect(res.headers.vary, origin).toContain('Origin');
      }
    } finally {
      await rig.close();
    }
  });

  test('an opaque-Origin preflight is not granted; a loopback preflight still is', async () => {
    const rig = await bootNativeRig();
    try {
      const preflight = (origin: string) =>
        rawRequest(rig.port, '/api/native-mutating', {
          method: 'OPTIONS',
          headers: {
            Origin: origin,
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type',
          },
        });
      for (const origin of OPAQUE_ORIGINS) {
        const res = await preflight(origin);
        expect(res.status, origin).toBe(origin === 'null' ? 403 : 204);
        expectNoCorsGrant(res.headers);
      }
      const loopback = await preflight('http://localhost:5173');
      expect(loopback.status).toBe(204);
      expect(loopback.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      expect(loopback.headers['access-control-allow-headers']).toBe(EXPECTED_ALLOW_HEADERS);
      expect(rig.dispatched).toEqual([]);
    } finally {
      await rig.close();
    }
  });

  test('every write from an opaque Origin is refused 403 before dispatch, whatever its body', async () => {
    const rig = await bootNativeRig();
    try {
      const bodies: Array<{ headers: Record<string, string>; body?: string }> = [
        { headers: { 'Content-Type': 'application/json' }, body: '{"path":"x.md"}' },
        { headers: { 'Content-Type': 'text/plain' }, body: '{"path":"x.md"}' },
        { headers: { 'Content-Type': 'multipart/form-data; boundary=b' }, body: '--b--\r\n' },
        { headers: {} },
      ];
      for (const origin of OPAQUE_ORIGINS) {
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
          for (const path of ['/api/native-mutating', '/api/native-upload']) {
            for (const shape of bodies) {
              const res = await rawRequest(rig.port, path, {
                method,
                headers: { ...shape.headers, Origin: origin },
                ...(shape.body !== undefined ? { body: shape.body } : {}),
              });
              const label = `${origin} ${method} ${path} ${shape.headers['Content-Type'] ?? 'bodyless'}`;
              expect(res.status, label).toBe(403);
              const problem = parseProblem(res.body);
              expect(problem.type, label).toBe('urn:ok:error:invalid-origin');
              expect(problem.detail, label).toBe(OPAQUE_DETAIL);
              expectNoCorsGrant(res.headers);
            }
          }
        }
      }
      expect(rig.dispatched).toEqual([]);
    } finally {
      await rig.close();
    }
  });

  test('body media types are not gated at the pipeline layer: every shape reaches dispatch', async () => {
    const rig = await bootNativeRig();
    try {
      for (const [method, contentType, hasBody] of [
        ['POST', 'application/json', true],
        ['POST', 'text/plain', true],
        ['POST', 'multipart/form-data; boundary=b', true],
        ['POST', undefined, false],
        ['DELETE', 'text/plain', true],
        ['GET', 'text/plain', false],
      ] as const) {
        const res = await rawRequest(rig.port, '/api/native-mutating', {
          method,
          headers: contentType === undefined ? {} : { 'Content-Type': contentType },
          ...(hasBody ? { body: '{"path":"x.md"}' } : {}),
        });
        expect(res.status, `${method} ${contentType ?? 'bodyless'}`).toBe(200);
      }
      expect(rig.dispatched).toEqual([
        'POST /api/native-mutating',
        'POST /api/native-mutating',
        'POST /api/native-mutating',
        'POST /api/native-mutating',
        'DELETE /api/native-mutating',
        'GET /api/native-mutating',
      ]);
    } finally {
      await rig.close();
    }
  });
});

describe('createApiRouteGroup', () => {
  const handler = async () => {};

  test('exact paths resolve with the URL as template; everything else declines', () => {
    const group = createApiRouteGroup({ '/api/alpha': handler, '/api/beta': handler });
    expect(group.paths).toEqual(['/api/alpha', '/api/beta']);
    const hit = group.table.resolve('/api/alpha');
    expect(hit?.template).toBe('/api/alpha');
    expect(hit?.dispatch).toBeDefined();
    expect(group.table.resolve('/api/gamma')).toBeNull();
  });

  test('mutating membership is URL-keyed and defaults to none', () => {
    const readOnly = createApiRouteGroup({ '/api/alpha': handler });
    expect(readOnly.table.isMutating('/api/alpha')).toBe(false);
    const mixed = createApiRouteGroup(
      { '/api/alpha': handler, '/api/beta': handler },
      { mutating: ['/api/beta'] },
    );
    expect(mixed.table.isMutating('/api/alpha')).toBe(false);
    expect(mixed.table.isMutating('/api/beta')).toBe(true);
  });

  test('mutatingPrefixes protect a namespace family by default, matching the legacy prefix rule', () => {
    const group = createApiRouteGroup(
      { '/api/local-op/clone': handler },
      { mutatingPrefixes: ['/api/local-op/'] },
    );
    expect(group.table.isMutating('/api/local-op/clone')).toBe(true);
    expect(group.table.isMutating('/api/local-op/brand-new-route')).toBe(true);
    expect(group.table.isMutating('/api/alpha')).toBe(false);
  });

  test('a mutating dynamic namespace declares its prefix in mutatingPrefixes', () => {
    const group = createApiRouteGroup(
      {},
      {
        mutatingPrefixes: ['/api/thing/'],
        dynamic: {
          prefix: '/api/thing/',
          template: '/api/thing/:id',
          dispatch: () => undefined,
        },
      },
    );
    expect(group.table.isMutating('/api/thing/abc')).toBe(true);
    expect(group.table.isMutating('/api/other')).toBe(false);
  });

  test('a malformed or orphaned mutatingPrefixes entry fails at construction', () => {
    expect(() =>
      createApiRouteGroup(
        { '/api/local-op/clone': handler },
        { mutatingPrefixes: ['/api/local-op'] },
      ),
    ).toThrow(/must end in '\/'/);
    expect(() =>
      createApiRouteGroup(
        { '/api/local-op/clone': handler },
        { mutatingPrefixes: ['/api/loca-op/'] },
      ),
    ).toThrow(/covers no registered route/);
  });

  test('a namespace-subsuming family collapses to the wildcard claim; keys outside the prefix stay mounted', () => {
    const group = createApiRouteGroup(
      { '/api/thing/alpha': handler, '/api/thing/nested/beta': handler, '/api/other': handler },
      {
        dynamic: {
          prefix: '/api/thing/',
          template: '/api/thing/:op',
          dispatch: () => undefined,
        },
      },
    );
    expect([...group.paths].sort()).toEqual(['/api/other', '/api/thing/*']);
    const member = group.table.resolve('/api/thing/alpha');
    expect(member?.template).toBe('/api/thing/alpha');
    expect(member?.dispatch).toBeDefined();
    const unknown = group.table.resolve('/api/thing/some-future-op');
    expect(unknown?.template).toBe('/api/thing/:op');
    expect(unknown?.dispatch).toBeUndefined();
  });

  test('a bare dynamic.prefix fails at construction — its wildcard would swallow unrelated siblings', () => {
    expect(() =>
      createApiRouteGroup(
        { '/api/local-op/clone': handler },
        {
          dynamic: {
            prefix: '/api/local-op',
            template: '/api/local-op/:op',
            dispatch: () => undefined,
          },
        },
      ),
    ).toThrow(/must end in '\/'/);
  });

  test('a dynamic leg claims its namespace: wildcard path, bound template, 404-able empty tail', () => {
    const seen: string[] = [];
    const group = createApiRouteGroup(
      { '/api/tags': handler },
      {
        dynamic: {
          prefix: '/api/tags/',
          template: '/api/tags/:name',
          dispatch: (suffix) => {
            if (!suffix) return undefined;
            return async () => {
              seen.push(suffix);
            };
          },
        },
      },
    );
    expect(group.paths).toEqual(['/api/tags', '/api/tags/*']);
    const named = group.table.resolve('/api/tags/til');
    expect(named?.template).toBe('/api/tags/:name');
    expect(named?.dispatch).toBeDefined();
    const empty = group.table.resolve('/api/tags/');
    expect(empty?.template).toBe('/api/tags/:name');
    expect(empty?.dispatch).toBeUndefined();
    expect(group.table.resolve('/api/other')).toBeNull();
  });
});
