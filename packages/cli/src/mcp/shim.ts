import { type ChildProcess, spawn as nativeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';
import { clientVersionHeaders, SPAWN_ERROR_LOG } from '@inkeep/open-knowledge-core';
import { startKeepalive as defaultStartKeepalive } from '@inkeep/open-knowledge-core/keepalive';
import {
  AutoStartDisabledError,
  isProcessAlive as defaultIsProcessAlive,
  MCP_CONNECTION_ID_HEADER,
  RUNTIME_VERSION,
  readServerLock,
  type ServerLockMetadata,
} from '@inkeep/open-knowledge-server';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { JSONRPCMessage, RequestId } from '@modelcontextprotocol/sdk/types.js';
import { resolveSelfSpawn } from '../commands/self-spawn.ts';

const DEFAULT_SPAWN_TIMEOUT_MS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

interface ShimTransport {
  onerror: ((err: Error) => void) | undefined;
  onclose: (() => void) | undefined;
  onmessage: ((msg: JSONRPCMessage) => void) | undefined;
  setProtocolVersion?: (version: string) => void;
  start(): Promise<void>;
  close(): Promise<void>;
  send(msg: JSONRPCMessage): Promise<void>;
}

function makeFetchWithTimeout(
  timeoutMs: number,
): (url: string | URL, init?: RequestInit) => Promise<Response> {
  return (url, init) => {
    if ((init?.method ?? 'GET').toUpperCase() === 'GET') {
      return globalThis.fetch(url as URL, init);
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`MCP request timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const signal =
      init?.signal instanceof AbortSignal
        ? AbortSignal.any([init.signal, controller.signal])
        : controller.signal;
    return globalThis.fetch(url as URL, { ...init, signal }).finally(() => clearTimeout(timer));
  };
}

export function parseSpawnTimeoutEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return undefined;
  return parsed;
}

interface ResolveMcpHttpUrlOptions {
  lockDir: string;
  contentDir: string;
  portOverride?: string;
  envAutoStart?: string;
  spawn?: typeof nativeSpawn;
  readLock?: () => ServerLockMetadata | null;
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  readErrorLog?: (path: string) => string;
  openErrorLog?: (path: string) => number;
  closeFd?: (fd: number) => void;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

interface StartMcpShimOptions extends ResolveMcpHttpUrlOptions {
  stderr?: NodeJS.WritableStream;
  startKeepalive?: typeof defaultStartKeepalive;
  createConnectionId?: () => string;
  bridgeFn?: (
    endpointUrl: string,
    opts?: BridgeStdioToHttpMcpOptions,
  ) => Promise<{ close: () => Promise<void> }>;
}

interface BridgeStdioToHttpMcpOptions {
  stderr?: NodeJS.WritableStream;
  stdin?: Readable;
  stdout?: Writable;
  requestTimeoutMs?: number;
  connectionId?: string;
  onclose?: () => void;
  createStdioTransport?: (
    stdin: Readable | undefined,
    stdout: Writable | undefined,
  ) => ShimTransport;
  createHttpTransport?: (url: URL) => ShimTransport;
}

function formatHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') return 'localhost';
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function mcpUrlForPort(host: string, port: number): string {
  return `http://${formatHost(host)}:${port}/mcp`;
}

function wsUrlForPort(host: string, port: number): string {
  return `ws://${formatHost(host)}:${port}`;
}

function wsUrlFromMcpEndpoint(endpointUrl: string): string {
  const url = new URL(endpointUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function livePortFromLock(
  lock: ServerLockMetadata | null,
  isAlive: (pid: number) => boolean,
): number | undefined {
  if (!lock || lock.port <= 0) return undefined;
  if (!isAlive(lock.pid)) return undefined;
  return lock.port;
}

function readErrorLogDefault(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf-8').trim() : '';
}

function formatTimeoutMessage(timeoutMs: number, stderr: string): string {
  const stderrBlock = stderr ? ` stderr:\n${stderr}` : '';
  return `server did not start within ${timeoutMs}ms${stderrBlock}`;
}

function requestIdOf(message: JSONRPCMessage): RequestId | undefined {
  if (message && typeof message === 'object' && 'method' in message && 'id' in message) {
    return message.id;
  }
  return undefined;
}

function maybeProtocolVersion(message: JSONRPCMessage): string | undefined {
  if (!message || typeof message !== 'object' || !('result' in message)) return undefined;
  const result = message.result;
  if (!result || typeof result !== 'object' || !('protocolVersion' in result)) return undefined;
  const version = result.protocolVersion;
  return typeof version === 'string' ? version : undefined;
}

function toErrorResponse(id: RequestId, err: unknown): JSONRPCMessage {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message: err instanceof Error ? err.message : String(err),
    },
  };
}

export async function resolveMcpHttpUrl(opts: ResolveMcpHttpUrlOptions): Promise<string> {
  const readLock = opts.readLock ?? (() => readServerLock(opts.lockDir));
  const isAlive = opts.isAlive ?? defaultIsProcessAlive;
  const sleep = opts.sleep ?? ((ms: number) => wait(ms));
  const spawnFn = opts.spawn ?? nativeSpawn;
  const readErrorLog = opts.readErrorLog ?? readErrorLogDefault;
  const openErrorLog = opts.openErrorLog ?? ((path: string) => openSync(path, 'w'));
  const closeFd = opts.closeFd ?? closeSync;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  if (opts.portOverride !== undefined) {
    const parsed = Number.parseInt(opts.portOverride, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      throw new Error(
        `invalid --port value '${opts.portOverride}' — HTTP MCP shim requires a positive port`,
      );
    }
    return mcpUrlForPort('localhost', parsed);
  }

  const existingPort = livePortFromLock(readLock(), isAlive);
  if (existingPort !== undefined) return mcpUrlForPort('localhost', existingPort);

  if (opts.envAutoStart === '0') {
    throw new AutoStartDisabledError(
      'OpenKnowledge server is not running and OK_MCP_AUTOSTART=0 disables auto-start.',
    );
  }

  if (!existsSync(opts.lockDir)) mkdirSync(opts.lockDir, { recursive: true });
  const stderrPath = join(opts.lockDir, SPAWN_ERROR_LOG);
  const stderrFd = openErrorLog(stderrPath);
  let child: ChildProcess | undefined;
  let asyncSpawnError: string | undefined;
  const self = resolveSelfSpawn();

  try {
    try {
      child = spawnFn(self.command, [...self.prefixArgs, 'start'], {
        detached: true,
        stdio: ['ignore', 'ignore', stderrFd],
        cwd: opts.contentDir,
        env: {
          ...process.env,
          OK_LOCK_KIND: 'mcp-spawned',
          ELECTRON_RUN_AS_NODE: '1',
        },
      });
      child.on('error', (err) => {
        asyncSpawnError = err instanceof Error ? err.message : String(err);
      });
      child.unref();
    } catch (err) {
      asyncSpawnError = err instanceof Error ? err.message : String(err);
    }
  } finally {
    try {
      closeFd(stderrFd);
    } catch {}
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (asyncSpawnError) {
      const stderr = readErrorLog(stderrPath);
      const stderrBlock = stderr ? ` stderr:\n${stderr}` : '';
      throw new Error(`spawn failed: ${asyncSpawnError}${stderrBlock}`);
    }
    await sleep(pollIntervalMs);
    const port = livePortFromLock(readLock(), isAlive);
    if (port !== undefined) return mcpUrlForPort('localhost', port);
  }

  if (asyncSpawnError) {
    const stderr = readErrorLog(stderrPath);
    const stderrBlock = stderr ? ` stderr:\n${stderr}` : '';
    throw new Error(`spawn failed: ${asyncSpawnError}${stderrBlock}`);
  }

  throw new Error(formatTimeoutMessage(timeoutMs, readErrorLog(stderrPath)));
}

export function resolveMcpKeepaliveWsUrl(
  opts: ResolveMcpHttpUrlOptions,
  endpointUrl: string,
): string | undefined {
  if (opts.portOverride !== undefined) return wsUrlFromMcpEndpoint(endpointUrl);
  const readLock = opts.readLock ?? (() => readServerLock(opts.lockDir));
  const isAlive = opts.isAlive ?? defaultIsProcessAlive;
  const port = livePortFromLock(readLock(), isAlive);
  if (port !== undefined) return wsUrlForPort('localhost', port);
  return undefined;
}

export async function bridgeStdioToHttpMcp(
  endpointUrl: string,
  opts: BridgeStdioToHttpMcpOptions = {},
): Promise<{ close: () => Promise<void> }> {
  const stderr = opts.stderr ?? process.stderr;
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  const stdio: ShimTransport = opts.createStdioTransport
    ? opts.createStdioTransport(opts.stdin, opts.stdout)
    : (new StdioServerTransport(opts.stdin, opts.stdout) as unknown as ShimTransport);

  const http: ShimTransport = opts.createHttpTransport
    ? opts.createHttpTransport(new URL(endpointUrl))
    : (new StreamableHTTPClientTransport(new URL(endpointUrl), {
        fetch: makeFetchWithTimeout(requestTimeoutMs),
        requestInit: {
          headers: {
            ...clientVersionHeaders({ kind: 'mcp', runtimeVersion: RUNTIME_VERSION }),
            ...(opts.connectionId !== undefined
              ? { [MCP_CONNECTION_ID_HEADER]: opts.connectionId }
              : {}),
          },
        },
      }) as unknown as ShimTransport);

  let closed = false;

  const closeBoth = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    opts.onclose?.();
    await Promise.allSettled([stdio.close(), http.close()]);
  };

  stdio.onerror = (err) => {
    stderr.write(`[mcp-shim] stdio error: ${err.message}\n`);
  };
  http.onerror = (err) => {
    stderr.write(`[mcp-shim] HTTP transport error: ${err.message}\n`);
  };
  stdio.onclose = () => {
    void closeBoth();
  };
  http.onclose = () => {
    void closeBoth();
  };

  let forwardQueue = Promise.resolve();
  stdio.onmessage = (message) => {
    forwardQueue = forwardQueue
      .then(async () => {
        try {
          await http.send(message);
        } catch (err) {
          const id = requestIdOf(message);
          if (id === undefined) {
            stderr.write(
              `[mcp-shim] failed to forward stdio notification: ${err instanceof Error ? err.message : String(err)}\n`,
            );
            return;
          }
          await stdio.send(toErrorResponse(id, err)).catch((sendErr) => {
            stderr.write(
              `[mcp-shim] failed to write stdio error response: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}\n`,
            );
          });
        }
      })
      .catch((err) => {
        stderr.write(
          `[mcp-shim] unexpected stdio forwarding failure: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      });
  };

  http.onmessage = (message) => {
    const protocolVersion = maybeProtocolVersion(message);
    if (protocolVersion) http.setProtocolVersion?.(protocolVersion);
    void stdio.send(message).catch((err) => {
      stderr.write(
        `[mcp-shim] failed to write stdio response: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    });
  };

  try {
    await http.start();
    await stdio.start();
  } catch (err) {
    await closeBoth();
    throw err;
  }

  return { close: closeBoth };
}

export async function startMcpShim(opts: StartMcpShimOptions): Promise<void> {
  const stderr = opts.stderr ?? process.stderr;
  const bridgeFn = opts.bridgeFn ?? bridgeStdioToHttpMcp;
  const endpointUrl = await resolveMcpHttpUrl(opts);
  const connectionId = opts.createConnectionId?.() ?? randomUUID();

  let shuttingDown = false;

  const keepalive = (opts.startKeepalive ?? defaultStartKeepalive)({
    connectionId,
    pid: process.pid,
    resolveWsUrl: async () => resolveMcpKeepaliveWsUrl(opts, endpointUrl),
    log: (msg) => stderr.write(`[mcp-shim] keepalive: ${msg}\n`),
  });
  stderr.write(`[mcp-shim] proxying stdio to ${endpointUrl}\n`);
  let bridge: Awaited<ReturnType<typeof bridgeFn>>;
  try {
    bridge = await bridgeFn(endpointUrl, {
      stderr,
      connectionId,
      onclose: () => {
        if (!shuttingDown) {
          keepalive.close();
          process.exit(0);
        }
      },
    });
  } catch (err) {
    keepalive.close();
    throw err;
  }

  const shutdown = (): void => {
    shuttingDown = true;
    keepalive.close();
    void bridge.close().finally(() => {
      process.exit(0);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
