import { createServer, type Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildIngressPolicy } from '../ingress-policy.ts';
import { listenOnLoopback } from '../loopback-rig-test-helpers.ts';
import type { McpHttpHandler } from '../mcp-http.ts';
import { createMcpDispatch } from './mcp-route.ts';

// The dispatch is fire-and-forget, so its `.catch()` is the ONLY error
// surface for the leg — a rejected `handle` must terminate the response on
// every branch (typed 500 before any write, plain end after a partial write,
// log-only after a completed one) or the client hangs until requestTimeout.

const log = {
  error: vi.fn(),
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => log,
};

let servers: HttpServer[] = [];

afterEach(async () => {
  const active = servers;
  servers = [];
  vi.mocked(log.error).mockClear();
  await Promise.allSettled(
    active.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function serveDispatch(handle: McpHttpHandler['handle']): Promise<{ baseUrl: string }> {
  const dispatch = createMcpDispatch(
    { handle, close: async () => {} },
    buildIngressPolicy({}),
    log as never,
  );
  const server = createServer((req, res) => dispatch(req, res));
  const { baseUrl } = await listenOnLoopback(server);
  servers.push(server);
  return { baseUrl };
}

describe('createMcpDispatch rejected-handle error surface', () => {
  test('a rejection before any write emits the typed 500 problem+json', async () => {
    const { baseUrl } = await serveDispatch(async () => {
      throw new Error('sdk exploded before writing');
    });

    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(5_000),
    });

    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = (await res.json()) as { type?: string; status?: number };
    expect(body.type).toBe('urn:ok:error:internal-server-error');
    expect(body.status).toBe(500);
  });

  test('a rejection after a partial write ends the response instead of hanging', async () => {
    const { baseUrl } = await serveDispatch(async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"partial":');
      throw new Error('sdk exploded mid-write');
    });

    // A hang here would leave the fetch pending until the abort fires.
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(5_000),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"partial":');
  });

  test('a rejection after the response completed is log-only', async () => {
    const { baseUrl } = await serveDispatch(async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      throw new Error('sdk exploded post-response');
    });

    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(5_000),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    await vi.waitFor(() => {
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'Unhandled MCP HTTP error',
      );
    });
  });
});
