import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { makeCaptureRes, makeSyntheticReq, rawRequest } from '../composition-rig.test-helper.ts';
import { buildIngressPolicy } from '../ingress-policy.ts';
import { loggerFactory } from '../logger.ts';
import { listenOnLoopback } from '../loopback-rig-test-helpers.ts';
import { type ContentDispatchOptions, createContentDispatch } from './content-dispatch.ts';
import { createHttpApp } from './http-app.ts';

const servers: Server[] = [];

async function start(options: Partial<ContentDispatchOptions> = {}) {
  const log = loggerFactory.getLogger('content-dispatch-test');
  const legacy = vi.fn(
    (_req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
      res.writeHead(418);
      res.end('legacy sentinel');
    },
  );
  const app = createHttpApp({
    log,
    legacyDispatch: legacy,
    contentDispatch: createContentDispatch({
      ingressPolicy: buildIngressPolicy({}),
      log,
      ...options,
    }),
  });
  const server = createServer(app.requestListener);
  servers.push(server);
  const { port } = await listenOnLoopback(server);
  return { port, legacy };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe('native content fallback ownership and middleware failures', () => {
  test('non-API failures and no-shell hints never traverse legacy dispatch', async () => {
    const { port, legacy } = await start();
    const missing = await rawRequest(port, '/unrecognized');
    expect(missing.status).toBe(404);
    expect(missing.body).toContain('running without the web UI');
    expect(legacy).not.toHaveBeenCalled();
    const api = await rawRequest(port, '/api/remaining');
    expect(api.status).toBe(418);
    expect(api.body).toBe('legacy sentinel');
  });

  test.each(['contentAssetMiddleware', 'reactShellMiddleware'] as const)(
    '%s failure before headers is a problem response',
    async (key) => {
      const { port, legacy } = await start({
        [key]: () => {
          readFileSync('/nonexistent-ok-middleware-failure');
        },
      });
      const response = await rawRequest(port, '/route');
      expect(response.status).toBe(500);
      expect(response.headers['content-type']).toBe('application/problem+json');
      expect(response.body).toContain('urn:ok:error:internal-server-error');
      expect(legacy).not.toHaveBeenCalled();
    },
  );

  test.each(['contentAssetMiddleware', 'reactShellMiddleware'] as const)(
    '%s failure after headers ends only the original bytes',
    async (key) => {
      const { port, legacy } = await start({
        [key]: (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.write('partial bytes');
          readFileSync('/nonexistent-ok-middleware-failure');
        },
      });
      const response = await rawRequest(port, '/route');
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('application/octet-stream');
      expect(response.body).toBe('partial bytes');
      expect(legacy).not.toHaveBeenCalled();
    },
  );

  test('next after a response cannot append shell bytes', async () => {
    const { port, legacy } = await start({
      contentAssetMiddleware: (_req, res, next) => {
        res.end('content');
        next();
      },
      reactShellMiddleware: (_req, res) => {
        res.end('shell');
      },
    });
    expect((await rawRequest(port, '/route')).body).toBe('content');
    expect(legacy).not.toHaveBeenCalled();
  });

  test('forwarded admission precedes content execution and ephemeral Host admission precedes a content miss', async () => {
    const { port, legacy } = await start({
      ephemeral: true,
      contentAssetMiddleware: (_req, res) => {
        res.end('content reached');
      },
    });
    const forwarded = await rawRequest(port, '/route', {
      headers: { 'X-Forwarded-Host': 'public.example' },
    });
    expect(forwarded.status).toBe(403);
    expect(forwarded.body).toContain('Proxied request refused');
    const host = await rawRequest(port, '/route', { headers: { Host: 'evil.example' } });
    expect(host.status).toBe(403);
    expect(host.body).toContain('Host header not allowed');
    expect(legacy).not.toHaveBeenCalled();
  });
});

test('ephemeral peer refusal precedes Host admission and content execution', () => {
  const content = vi.fn();
  const shell = vi.fn();
  const dispatch = createContentDispatch({
    ephemeral: true,
    ingressPolicy: buildIngressPolicy({}),
    log: loggerFactory.getLogger('content-peer-test'),
    contentAssetMiddleware: content,
    reactShellMiddleware: shell,
  });
  const { res, captured } = makeCaptureRes();
  dispatch(
    makeSyntheticReq({ url: '/document.png', remoteAddress: '203.0.113.7', host: 'evil.example' }),
    res,
  );
  expect(captured.status).toBe(403);
  expect(JSON.parse(captured.body).type).toBe('urn:ok:error:loopback-required');
  expect(content).not.toHaveBeenCalled();
  expect(shell).not.toHaveBeenCalled();
});
