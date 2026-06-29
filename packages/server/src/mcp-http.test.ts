import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { type Config, ConfigSchema } from './config/schema.ts';
import { getFreeLoopbackPort } from './loopback-rig-test-helpers.ts';
import { MCP_CONNECTION_ID_HEADER } from './mcp/agent-identity.ts';
import {
  createMcpHttpHandler,
  type McpHttpHandler,
  type McpHttpHandlerOptions,
} from './mcp-http.ts';

const MCP_PROTOCOL_VERSION = '2025-06-18';

interface SessionHarness {
  contentDir: string;
  port: number;
  cleanup: () => Promise<void>;
}

async function bootHandler(
  config: Config,
  handlerOptions: Partial<Pick<McpHttpHandlerOptions, 'log' | 'maxSessions' | 'sessionTtlMs'>> = {},
): Promise<SessionHarness> {
  const contentDir = mkdtempSync(join(tmpdir(), 'ok-mcp-http-cfg-'));
  const port = await getFreeLoopbackPort();
  let handler: McpHttpHandler | null = null;
  let httpServer: HttpServer | null = null;
  try {
    handler = createMcpHttpHandler({
      contentDir,
      projectDir: contentDir,
      config,
      getServerUrl: () => `http://127.0.0.1:${port}`,
      ...handlerOptions,
    });

    httpServer = createHttpServer((req, res) => {
      const url = req.url?.split('?')[0];
      if (url === '/mcp') {
        // biome-ignore lint/style/noNonNullAssertion: handler is set inside the try
        handler!.handle(req, res).catch((err: unknown) => {
          if (!res.writableEnded) {
            res.writeHead(500);
            res.end(`Internal server error: ${(err as Error).message ?? String(err)}`);
          }
        });
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    });
    await new Promise<void>((res) => {
      // biome-ignore lint/style/noNonNullAssertion: httpServer is set inside the try
      httpServer!.listen(port, '127.0.0.1', () => res());
    });
  } catch (err) {
    if (httpServer) await new Promise<void>((res) => httpServer?.close(() => res()));
    if (handler) await handler.close();
    rmSync(contentDir, { recursive: true, force: true });
    throw err;
  }

  return {
    contentDir,
    port,
    cleanup: async () => {
      // biome-ignore lint/style/noNonNullAssertion: handler/httpServer are non-null after successful boot
      await handler!.close();
      // biome-ignore lint/style/noNonNullAssertion: see above
      await new Promise<void>((res) => httpServer!.close(() => res()));
      rmSync(contentDir, { recursive: true, force: true });
    },
  };
}

interface InitializedSession {
  sessionId: string;
  protocolVersion: string;
}

async function openMcpSession(port: number): Promise<InitializedSession> {
  const init = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'us-006-config-probe', version: '0.0.0' },
      },
    }),
  });
  expect(init.status).toBe(200);
  const sessionId = init.headers.get('mcp-session-id');
  expect(sessionId).toBeTruthy();
  const initBody = (await init.json()) as {
    result?: { protocolVersion?: string };
  };
  const protocolVersion = initBody.result?.protocolVersion ?? MCP_PROTOCOL_VERSION;

  const initialized = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-session-id': sessionId as string,
      'mcp-protocol-version': protocolVersion,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  expect(initialized.status).toBe(202);

  return { sessionId: sessionId as string, protocolVersion };
}

let openHarnesses: SessionHarness[] = [];

beforeEach(() => {
  openHarnesses = [];
});

afterEach(async () => {
  await Promise.allSettled(openHarnesses.map((h) => h.cleanup()));
  openHarnesses = [];
});

test('active MCP session cap refuses new sessions before allocation', async () => {
  const config: Config = ConfigSchema.parse({});
  const harness = await bootHandler(config, { maxSessions: 1 });
  openHarnesses.push(harness);

  await openMcpSession(harness.port);

  const second = await fetch(`http://127.0.0.1:${harness.port}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'over-cap', version: '0.0.0' },
      },
    }),
  });

  expect(second.status).toBe(503);
  expect(await second.text()).toContain('Too many active MCP sessions');
});

test('mcp-tool-path-traversal: explicit cwd outside configured project root is rejected', async () => {
  const config: Config = ConfigSchema.parse({});
  const harness = await bootHandler(config);
  openHarnesses.push(harness);

  const session = await openMcpSession(harness.port);

  const callExec = async (cwd: string) =>
    fetch(`http://127.0.0.1:${harness.port}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-session-id': session.sessionId,
        'mcp-protocol-version': session.protocolVersion,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 999,
        method: 'tools/call',
        params: {
          name: 'exec',
          arguments: { command: 'cat passwd', cwd },
        },
      }),
    });

  const escapeResponse = await callExec('/etc');
  expect(escapeResponse.status).toBe(200);
  const body = (await escapeResponse.json()) as {
    result?: { isError?: boolean; content?: Array<{ text?: string }> };
  };
  expect(body.result?.isError).toBe(true);
  const text = body.result?.content?.[0]?.text ?? '';
  expect(text).toMatch(/not within the configured project root|escapes the configured root/);
});

test('PRD-6659: tools/call write with an invalid position returns field name + allowed values', async () => {
  const config: Config = ConfigSchema.parse({});
  const harness = await bootHandler(config);
  openHarnesses.push(harness);

  const session = await openMcpSession(harness.port);

  const callRes = await fetch(`http://127.0.0.1:${harness.port}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-session-id': session.sessionId,
      'mcp-protocol-version': session.protocolVersion,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: {
        name: 'write',
        arguments: { document: { path: 'foo', content: 'hello', position: 'middle' } },
      },
    }),
  });

  expect(callRes.status).toBe(200);
  const body = (await callRes.json()) as {
    result?: { isError?: boolean; content?: Array<{ text?: string }> };
  };
  expect(body.result?.isError).toBe(true);
  const text = body.result?.content?.[0]?.text ?? '';
  expect(text).toContain('position');
  expect(text).toContain('append');
  expect(text).toContain('prepend');
  expect(text).toContain('replace');
  expect(text).not.toContain('"code":');
  expect(text).not.toContain('"path":');
  expect(text.trim()).not.toBe('Required');
});

test('forwarded connectionId header reaches /api/agent-write-md as agentId', async () => {
  const config: Config = ConfigSchema.parse({});
  const contentDir = mkdtempSync(join(tmpdir(), 'ok-mcp-http-cid-'));
  const port = await getFreeLoopbackPort();
  let handler: McpHttpHandler | null = null;
  let httpServer: HttpServer | null = null;
  let capturedAgentId: string | undefined;

  try {
    handler = createMcpHttpHandler({
      contentDir,
      projectDir: contentDir,
      config,
      getServerUrl: () => `http://127.0.0.1:${port}`,
    });

    httpServer = createHttpServer((req, res) => {
      const url = req.url?.split('?')[0];
      if (url === '/mcp') {
        // biome-ignore lint/style/noNonNullAssertion: handler set inside try
        handler!.handle(req, res).catch(() => {
          if (!res.writableEnded) {
            res.writeHead(500);
            res.end('handler error');
          }
        });
        return;
      }
      if (url === '/api/agent-write-md' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
              agentId?: unknown;
            };
            if (typeof body.agentId === 'string') capturedAgentId = body.agentId;
          } catch {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    });
    await new Promise<void>((res) => {
      // biome-ignore lint/style/noNonNullAssertion: httpServer set above
      httpServer!.listen(port, '127.0.0.1', () => res());
    });

    const forwarded = 'forwarded-keepalive-id-1234';

    const init = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        [MCP_CONNECTION_ID_HEADER]: forwarded,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'forwarded-id-probe', version: '0.0.0' },
        },
      }),
    });
    expect(init.status).toBe(200);
    const sessionId = init.headers.get('mcp-session-id') as string;
    expect(sessionId).toBeTruthy();
    const initBody = (await init.json()) as { result?: { protocolVersion?: string } };
    const protocolVersion = initBody.result?.protocolVersion ?? MCP_PROTOCOL_VERSION;

    const initialized = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-session-id': sessionId,
        'mcp-protocol-version': protocolVersion,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(initialized.status).toBe(202);

    const call = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-session-id': sessionId,
        'mcp-protocol-version': protocolVersion,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'write',
          arguments: {
            document: {
              path: 'forwarded-id-probe',
              content: 'hello\n',
              position: 'replace',
            },
          },
        },
      }),
    });
    expect(call.status).toBe(200);
    expect(capturedAgentId).toBe(forwarded);
  } finally {
    if (handler) await handler.close();
    if (httpServer) await new Promise<void>((res) => httpServer?.close(() => res()));
    rmSync(contentDir, { recursive: true, force: true });
  }
});

test('invalid connectionId header is ignored — session falls back to a fresh UUID', async () => {
  const config: Config = ConfigSchema.parse({});
  const contentDir = mkdtempSync(join(tmpdir(), 'ok-mcp-http-cid-bad-'));
  const port = await getFreeLoopbackPort();
  let handler: McpHttpHandler | null = null;
  let httpServer: HttpServer | null = null;
  let capturedAgentId: string | undefined;
  const warnCalls: Array<{ obj: object; msg: string }> = [];

  try {
    handler = createMcpHttpHandler({
      contentDir,
      projectDir: contentDir,
      config,
      getServerUrl: () => `http://127.0.0.1:${port}`,
      log: {
        warn: (obj, msg) => {
          warnCalls.push({ obj, msg });
        },
      },
    });

    httpServer = createHttpServer((req, res) => {
      const url = req.url?.split('?')[0];
      if (url === '/mcp') {
        // biome-ignore lint/style/noNonNullAssertion: handler set inside try
        handler!.handle(req, res).catch(() => {
          if (!res.writableEnded) {
            res.writeHead(500);
            res.end('handler error');
          }
        });
        return;
      }
      if (url === '/api/agent-write-md' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
              agentId?: unknown;
            };
            if (typeof body.agentId === 'string') capturedAgentId = body.agentId;
          } catch {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    });
    await new Promise<void>((res) => {
      // biome-ignore lint/style/noNonNullAssertion: httpServer set above
      httpServer!.listen(port, '127.0.0.1', () => res());
    });

    const forwarded = 'bad value with spaces!';

    const init = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        [MCP_CONNECTION_ID_HEADER]: forwarded,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'bad-cid-probe', version: '0.0.0' },
        },
      }),
    });
    expect(init.status).toBe(200);
    const sessionId = init.headers.get('mcp-session-id') as string;
    const initBody = (await init.json()) as { result?: { protocolVersion?: string } };
    const protocolVersion = initBody.result?.protocolVersion ?? MCP_PROTOCOL_VERSION;
    await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-session-id': sessionId,
        'mcp-protocol-version': protocolVersion,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });

    const call = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-session-id': sessionId,
        'mcp-protocol-version': protocolVersion,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'write',
          arguments: {
            document: {
              path: 'bad-cid-probe',
              content: 'hello\n',
              position: 'replace',
            },
          },
        },
      }),
    });
    expect(call.status).toBe(200);
    expect(capturedAgentId).toBeDefined();
    expect(capturedAgentId).not.toContain(forwarded);
    expect(capturedAgentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const headerWarn = warnCalls.find((call) =>
      call.msg.includes('forwarded connectionId header failed validation'),
    );
    expect(headerWarn).toBeDefined();
    expect(headerWarn?.obj).toEqual({ headerLength: forwarded.length });
  } finally {
    if (handler) await handler.close();
    if (httpServer) await new Promise<void>((res) => httpServer?.close(() => res()));
    rmSync(contentDir, { recursive: true, force: true });
  }
});

test('inactive MCP sessions expire and return 404 on later use', async () => {
  const config: Config = ConfigSchema.parse({});
  const harness = await bootHandler(config, { sessionTtlMs: 250 });
  openHarnesses.push(harness);

  const session = await openMcpSession(harness.port);
  await wait(350);

  const expired = await fetch(`http://127.0.0.1:${harness.port}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-session-id': session.sessionId,
      'mcp-protocol-version': session.protocolVersion,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
  });

  expect(expired.status).toBe(404);
  expect(await expired.text()).toContain('MCP session not found');
});
