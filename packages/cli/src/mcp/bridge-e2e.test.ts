import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';
import {
  ConfigSchema,
  createMcpHttpHandler,
  MCP_CONNECTION_ID_HEADER,
  MCP_SERVER_NAME,
  type McpHttpHandler,
  RUNTIME_VERSION,
} from '@inkeep/open-knowledge-server';
import { bridgeStdioToHttpMcp } from './shim.ts';

const MCP_PROTOCOL_VERSION = '2025-06-18';

interface Harness {
  contentDir: string;
  endpointUrl: string;
  handler: McpHttpHandler;
  httpServer: HttpServer;
}

const openHarnesses: Harness[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function encodeMessage(message: Record<string, unknown>): string {
  return `${JSON.stringify(message)}\n`;
}

function createMessageReader(stdout: PassThrough): {
  waitFor: (
    predicate: (message: Record<string, unknown>) => boolean,
  ) => Promise<Record<string, unknown>>;
} {
  let buffer = '';
  const messages: Record<string, unknown>[] = [];
  const waiters: Array<{
    predicate: (message: Record<string, unknown>) => boolean;
    resolve: (message: Record<string, unknown>) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  function drainWaiters(): void {
    for (let waiterIndex = 0; waiterIndex < waiters.length; waiterIndex++) {
      const waiter = waiters[waiterIndex];
      if (!waiter) continue;
      const messageIndex = messages.findIndex(waiter.predicate);
      if (messageIndex === -1) continue;
      const [message] = messages.splice(messageIndex, 1);
      clearTimeout(waiter.timer);
      waiters.splice(waiterIndex, 1);
      waiter.resolve(message);
      waiterIndex--;
    }
  }

  stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) break;
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line.length === 0) continue;
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) {
        throw new Error(`stdio response was not a JSON object: ${line}`);
      }
      messages.push(parsed);
    }
    drainWaiters();
  });

  return {
    waitFor(predicate) {
      const existingIndex = messages.findIndex(predicate);
      if (existingIndex !== -1) {
        const [message] = messages.splice(existingIndex, 1);
        return Promise.resolve(message);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.timer === timer);
          if (index !== -1) waiters.splice(index, 1);
          reject(new Error('timed out waiting for stdio JSON-RPC response'));
        }, 5_000);
        waiters.push({ predicate, resolve, reject, timer });
      });
    },
  };
}

async function startHttpMcpServer(): Promise<Harness> {
  const contentDir = mkdtempSync(join(tmpdir(), 'ok-mcp-bridge-e2e-'));
  writeFileSync(join(contentDir, 'bridge-note.md'), '# Bridge note\n\nstdio-http-bridge-marker\n');

  let port = 0;
  const handler = createMcpHttpHandler({
    contentDir,
    projectDir: contentDir,
    config: ConfigSchema.parse({}),
    getServerUrl: () => `http://127.0.0.1:${port}`,
  });

  const httpServer = createHttpServer((req, res) => {
    const url = req.url?.split('?')[0];
    if (url === '/mcp') {
      handler.handle(req, res).catch((err: unknown) => {
        if (!res.writableEnded) {
          res.writeHead(500);
          res.end(`Internal server error: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  try {
    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    port = (httpServer.address() as AddressInfo).port;
  } catch (err) {
    await handler.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    rmSync(contentDir, { recursive: true, force: true });
    throw err;
  }

  const harness = {
    contentDir,
    endpointUrl: `http://127.0.0.1:${port}/mcp`,
    handler,
    httpServer,
  };
  openHarnesses.push(harness);
  return harness;
}

async function cleanupHarness(harness: Harness): Promise<void> {
  await handlerClose(harness.handler);
  await new Promise<void>((resolve) => harness.httpServer.close(() => resolve()));
  rmSync(harness.contentDir, { recursive: true, force: true });
}

async function handlerClose(handler: McpHttpHandler): Promise<void> {
  await handler.close();
}

afterEach(async () => {
  const harnesses = openHarnesses.splice(0);
  await Promise.allSettled(harnesses.map((harness) => cleanupHarness(harness)));
});

test('stdio shim forwards connectionId via x-ok-connection-id header through real HTTP transport', async () => {
  // The shim's `connectionId` option flows through the real
  // `StreamableHTTPClientTransport({ requestInit: { headers: ... } })`
  // constructor — a path that the unit tests in shim.test.ts bypass via
  // their `createHttpTransport` factory override. Without an integration
  // test here, a regression that drops the requestInit spread or
  // misspells `MCP_CONNECTION_ID_HEADER` would silently break presence-
  // icon stickiness on the next release with no test signal.
  const harness = await startHttpMcpServer();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const reader = createMessageReader(stdout);
  const expectedConnectionId = 'shim-fwd-cid-1234';

  // Wrap the harness http server with a header-capture passthrough.
  // We can't intercept at the handler boundary because `createMcpHttpHandler`
  // owns the request — capture by replaying a fetch shim that observes
  // `req.headers` before delegating.
  const capturedConnectionIds: string[] = [];
  const capturedVersionHeaders: Array<Record<string, string | undefined>> = [];
  harness.httpServer.removeAllListeners('request');
  harness.httpServer.on('request', (req, res) => {
    const url = req.url?.split('?')[0];
    if (url === '/mcp') {
      const header = req.headers[MCP_CONNECTION_ID_HEADER];
      const headerValue = Array.isArray(header) ? header[0] : header;
      if (typeof headerValue === 'string') capturedConnectionIds.push(headerValue);
      const first = (name: string): string | undefined => {
        const v = req.headers[name];
        return Array.isArray(v) ? v[0] : v;
      };
      capturedVersionHeaders.push({
        protocol: first('x-ok-client-protocol'),
        runtime: first('x-ok-client-runtime'),
        kind: first('x-ok-client-kind'),
      });
      harness.handler.handle(req, res).catch((err: unknown) => {
        if (!res.writableEnded) {
          res.writeHead(500);
          res.end(`Internal server error: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  const bridge = await bridgeStdioToHttpMcp(harness.endpointUrl, {
    stdin,
    stdout,
    stderr,
    connectionId: expectedConnectionId,
  });

  try {
    stdin.write(
      encodeMessage({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'bridge-e2e-cid', version: '0.0.0' },
        },
      }),
    );

    const initialize = await reader.waitFor((message) => message.id === 1);
    expect(initialize.error).toBeUndefined();

    // Header was sent on the very first request — proves the bridge wired
    // `requestInit: { headers: { [MCP_CONNECTION_ID_HEADER]: connectionId } }`
    // correctly through the real `StreamableHTTPClientTransport` constructor.
    expect(capturedConnectionIds.length).toBeGreaterThan(0);
    expect(capturedConnectionIds[0]).toBe(expectedConnectionId);

    // the same real-transport path carries client version metadata on
    // every /mcp request, alongside the connection-id header.
    expect(capturedVersionHeaders[0]).toEqual({
      protocol: '1',
      runtime: RUNTIME_VERSION,
      kind: 'mcp',
    });
  } finally {
    await bridge.close();
  }
});

test('stdio shim proxies initialize and tool calls to the HTTP MCP server', async () => {
  const harness = await startHttpMcpServer();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const reader = createMessageReader(stdout);
  const bridge = await bridgeStdioToHttpMcp(harness.endpointUrl, { stdin, stdout, stderr });

  try {
    stdin.write(
      encodeMessage({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'bridge-e2e', version: '0.0.0' },
        },
      }),
    );

    const initialize = await reader.waitFor((message) => message.id === 1);
    expect(initialize.error).toBeUndefined();
    expect(initialize.jsonrpc).toBe('2.0');
    const initResult = initialize.result;
    expect(isRecord(initResult)).toBe(true);
    if (!isRecord(initResult)) throw new Error('initialize result was not an object');
    expect(initResult.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(initResult.serverInfo).toEqual(
      expect.objectContaining({ name: MCP_SERVER_NAME, version: expect.any(String) }),
    );

    stdin.write(encodeMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    await wait(25);

    // Use `exec("grep …")` instead of the retired `grep` MCP tool — the OK
    // MCP tool consolidation dropped the typed `grep` tool; exec subsumes it.
    stdin.write(
      encodeMessage({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'exec',
          arguments: {
            command: 'grep -rn stdio-http-bridge-marker .',
            cwd: harness.contentDir,
          },
        },
      }),
    );

    const toolCall = await reader.waitFor((message) => message.id === 2);
    expect(toolCall.error).toBeUndefined();
    const toolResult = toolCall.result;
    expect(isRecord(toolResult)).toBe(true);
    if (!isRecord(toolResult)) throw new Error('tool result was not an object');
    expect(toolResult.isError ?? false).toBe(false);
    // exec returns enrichedPaths + raw stdout; the structured content key
    // shape is different from the retired grep tool's matchCount surface.
    // We assert the marker is present in either the text or the structured
    // body — that's the bridge contract.
    expect(JSON.stringify(toolResult)).toContain('stdio-http-bridge-marker');
  } finally {
    await bridge.close();
  }
});
