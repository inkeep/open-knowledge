import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { type BootedServer, bootServer } from './boot.ts';
import { ConfigSchema } from './config/schema.ts';
import { connectMcpTestClient } from './mcp/client.test-helper.ts';
import { createMcpHttpHandler, type McpHttpHandler } from './mcp-http.ts';

export interface DualTransportMcpRig {
  readonly booted: BootedServer;
  readonly contentDir: string;
  readonly localClient: Client;
  readonly httpClient: Client;
  readonly close: () => Promise<void>;
}

export async function startDualTransportMcpRig(options: {
  readonly tmpPrefix: string;
  readonly clientName: string;
  readonly seed: (contentDir: string) => void;
}): Promise<DualTransportMcpRig> {
  const config = ConfigSchema.parse({});
  const tmpDir = await mkdtemp(resolve(tmpdir(), options.tmpPrefix));
  const contentDir = resolve(tmpDir, 'project');
  let booted: BootedServer | undefined;
  let httpOnlyMcp: McpHttpHandler | undefined;
  let sideServer: Server | undefined;
  let localClient: Client | undefined;
  let httpClient: Client | undefined;

  const close = async (): Promise<void> => {
    await localClient?.close().catch(() => {});
    await httpClient?.close().catch(() => {});
    await httpOnlyMcp?.close();
    sideServer?.closeAllConnections();
    sideServer?.close();
    await booted?.destroy();
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };

  try {
    mkdirSync(contentDir, { recursive: true });
    options.seed(contentDir);

    const server = await bootServer({
      host: '127.0.0.1',
      config,
      contentDir,
      port: 0,
      quiet: true,
      gitEnabled: false,
      idleShutdownMs: null,
    });
    booted = server;
    await server.ready;

    const handler = createMcpHttpHandler({
      contentDir: server.contentDir,
      projectDir: server.contentDir,
      config,
      getServerUrl: () => `http://127.0.0.1:${server.port}`,
    });
    httpOnlyMcp = handler;
    const side = createServer((req, res) => {
      void handler.handle(req, res);
    });
    sideServer = side;
    const sidePort = await new Promise<number>((resolvePort) => {
      side.listen(0, '127.0.0.1', () => {
        resolvePort((side.address() as AddressInfo).port);
      });
    });

    const identity = { name: options.clientName, version: '0.0.0-test' };
    const local = await connectMcpTestClient(`http://127.0.0.1:${server.port}/mcp`, identity);
    localClient = local;
    const http = await connectMcpTestClient(`http://127.0.0.1:${sidePort}/mcp`, identity);
    httpClient = http;

    return { booted: server, contentDir, localClient: local, httpClient: http, close };
  } catch (err) {
    try {
      await close();
    } catch (cleanupErr) {
      throw new AggregateError(
        [err, cleanupErr],
        'dual-transport MCP rig startup and cleanup failed',
      );
    }
    throw err;
  }
}
