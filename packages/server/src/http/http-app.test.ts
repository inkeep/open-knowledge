import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { describe, expect, test } from 'vitest';
import { rawRequest } from '../composition-rig.test-helper.ts';
import { buildIngressPolicy } from '../ingress-policy.ts';
import { listenOnLoopback } from '../loopback-rig-test-helpers.ts';
import {
  assertSingleRouterOwnership,
  type CreateHttpAppOptions,
  createHttpApp,
} from './http-app.ts';
import { createMcpDispatch } from './mcp-route.ts';

const fakeLog = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => fakeLog,
} as never;

async function serveWith(
  legacyDispatch: CreateHttpAppOptions['legacyDispatch'],
  mcpDispatch?: CreateHttpAppOptions['mcpDispatch'],
  ingressPolicy?: CreateHttpAppOptions['ingressPolicy'],
) {
  const { requestListener } = createHttpApp({
    legacyDispatch,
    mcpDispatch,
    ingressPolicy,
    log: fakeLog,
  });
  const server = createServer(requestListener);
  const { baseUrl } = await listenOnLoopback(server);
  return {
    baseUrl,
    port: Number(new URL(baseUrl).port),
    close: () =>
      new Promise<void>((resolvePromise, reject) => {
        server.close((err) => (err ? reject(err) : resolvePromise()));
      }),
  };
}

describe('createHttpApp adapter boundary', () => {
  test('mounting and serving leaves globalThis.Request/Response untouched', async () => {
    const RequestBefore = globalThis.Request;
    const ResponseBefore = globalThis.Response;
    const rig = await serveWith((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    try {
      const res = await fetch(`${rig.baseUrl}/anything`);
      expect(res.status).toBe(204);
      expect(globalThis.Request).toBe(RequestBefore);
      expect(globalThis.Response).toBe(ResponseBefore);
    } finally {
      await rig.close();
    }
  });

  test('the catch-all leaves the request body for the legacy dispatch to consume', async () => {
    const rig = await serveWith((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(body);
      });
    });
    try {
      const payload = 'x'.repeat(64 * 1024);
      const res = await fetch(`${rig.baseUrl}/echo`, { method: 'POST', body: payload });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(payload);
    } finally {
      await rig.close();
    }
  });

  test('a handler throw after headers are sent finalizes the response instead of hanging', async () => {
    const rig = await serveWith((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      throw new Error('post-head boom');
    });
    try {
      const res = await fetch(`${rig.baseUrl}/partial`, {
        signal: AbortSignal.timeout(5_000),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');
    } finally {
      await rig.close();
    }
  });
});

describe('createHttpApp native /mcp mount', () => {
  const policy = buildIngressPolicy({});

  function mcpDispatchOver(handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
    return createMcpDispatch({ handle, close: async () => {} }, policy, fakeLog);
  }

  test('/mcp serves from the native route with zero legacy-dispatch involvement', async () => {
    let legacyCalls = 0;
    let handled = 0;
    const dispatch = mcpDispatchOver(async (_req, res) => {
      handled += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    const rig = await serveWith(
      (_req, res) => {
        legacyCalls += 1;
        res.writeHead(204);
        res.end();
      },
      dispatch,
      policy,
    );
    try {
      const res = await fetch(`${rig.baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(200);
      expect(handled).toBe(1);
      expect(legacyCalls).toBe(0);
    } finally {
      await rig.close();
    }
  });

  test('a Hono-normalized alias of /mcp falls through to the legacy dispatch', async () => {
    let handled = 0;
    let legacyUrl: string | undefined;
    const dispatch = mcpDispatchOver(async (_req, res) => {
      handled += 1;
      res.writeHead(200);
      res.end();
    });
    const rig = await serveWith(
      (req, res) => {
        legacyUrl = req.url;
        res.writeHead(404);
        res.end();
      },
      dispatch,
      policy,
    );
    try {
      const res = await rawRequest(rig.port, '/./mcp', { method: 'POST' });
      expect(res.status).toBe(404);
      expect(handled).toBe(0);
      expect(legacyUrl).toBe('/./mcp');
    } finally {
      await rig.close();
    }
  });

  test('without an MCP handler /mcp falls through the strangler catch-all', async () => {
    let legacyUrl: string | undefined;
    const rig = await serveWith((req, res) => {
      legacyUrl = req.url;
      res.writeHead(404);
      res.end();
    });
    try {
      const res = await fetch(`${rig.baseUrl}/mcp`, { method: 'POST' });
      expect(res.status).toBe(404);
      expect(legacyUrl).toBe('/mcp');
    } finally {
      await rig.close();
    }
  });
});

describe('assertSingleRouterOwnership', () => {
  test('throws when a native path also exists in the legacy record', () => {
    expect(() =>
      assertSingleRouterOwnership(['/api/backlinks', '/api/tags/*'], {
        '/api/backlinks': async () => {},
      }),
    ).toThrow(
      'route(s) present in both the legacy dispatch record and a native route group: /api/backlinks',
    );
  });

  test('throws when a legacy record key falls under a native wildcard namespace', () => {
    expect(() =>
      assertSingleRouterOwnership(['/api/tags/*'], {
        '/api/tags/special': async () => {},
      }),
    ).toThrow('/api/tags/special (under a native wildcard)');
  });

  test('passes for disjoint sets, including a legacy key at the wildcard base', () => {
    expect(() =>
      assertSingleRouterOwnership(['/api/backlinks', '/api/tags/*'], {
        '/api/documents': async () => {},
        '/api/tags': async () => {},
      }),
    ).not.toThrow();
  });

  test('throws when two native groups claim the same path', () => {
    expect(() =>
      assertSingleRouterOwnership(['/api/backlinks', '/api/metrics/x', '/api/backlinks'], {}),
    ).toThrow('route(s) claimed by more than one native route group: /api/backlinks');
  });

  test("throws when one native group's wildcard covers another native path", () => {
    expect(() => assertSingleRouterOwnership(['/api/tags/*', '/api/tags/special'], {})).toThrow(
      '/api/tags/special (under a native wildcard)',
    );
  });

  test('passes for disjoint native groups concatenated, wildcard base included', () => {
    expect(() =>
      assertSingleRouterOwnership(
        ['/api/backlinks', '/api/tags/*', '/api/metrics/reconciliation', '/api/tags'],
        {},
      ),
    ).not.toThrow();
  });
});
