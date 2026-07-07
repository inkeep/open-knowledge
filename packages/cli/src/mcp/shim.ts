/**
 * `ok mcp` stdio → HTTP MCP shim — byte/JSON-RPC proxy strategy.
 *
 * The shim is deliberately a transport-only bridge: bytes/JSON-RPC frames
 * arrive on stdin via `StdioServerTransport`, get forwarded as-is to the
 * server-owned Streamable HTTP MCP endpoint via `StreamableHTTPClientTransport`,
 * and responses flow back the other direction. There is no `McpServer` or
 * `McpClient` instantiation in this process — tool registry, capability
 * negotiation, and request handling all live in the running `ok start`
 * process at `/mcp`.
 *
 * Protocol awareness in the shim is limited to one read: when the HTTP side
 * delivers an `initialize` response, `maybeProtocolVersion` extracts
 * `result.protocolVersion` (string, e.g. "2025-06-18") so we can call
 * `http.setProtocolVersion(...)` and keep both transport halves in sync with
 * whatever the server negotiated. No framing decisions, no method routing,
 * no schema validation — the shim is otherwise version-agnostic.
 *
 * `resolveMcpHttpUrl` returning a URL string keeps the local-loopback HTTP
 * transport socket-swappable: a future iteration could substitute a different
 * URL/transport without touching the bridge code.
 */
import { type ChildProcess, spawn as nativeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';
import {
  clientVersionHeaders,
  DEFAULT_SERVER_HOST,
  SPAWN_ERROR_LOG,
} from '@inkeep/open-knowledge-core';
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
// 120 s: generous headroom for slow tools (research/consolidate), yet finite so a
// hung server doesn't hold the entire bridge indefinitely.
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Minimal structural subset of the MCP SDK `Transport` interface used by the
 * bridge loop. Satisfied by both `StdioServerTransport` and
 * `StreamableHTTPClientTransport`; also implemented by test fakes.
 */
interface ShimTransport {
  onerror: ((err: Error) => void) | undefined;
  onclose: (() => void) | undefined;
  onmessage: ((msg: JSONRPCMessage) => void) | undefined;
  setProtocolVersion?: (version: string) => void;
  start(): Promise<void>;
  close(): Promise<void>;
  send(msg: JSONRPCMessage): Promise<void>;
}

/**
 * Wrap the global `fetch` so POST/DELETE requests time out after `timeoutMs`.
 * GET is intentionally exempted: the SSE receive channel is a long-lived
 * server-sent-events stream whose lifetime is the session, not a single RPC.
 * Timing that out would trigger reconnect storms on every idle interval.
 */
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

/**
 * Read `OK_MCP_SPAWN_TIMEOUT_MS` from the environment. Returns the parsed
 * number of milliseconds, or undefined when unset / invalid. Invalid values
 * fall back to the default rather than crashing the MCP — the env knob is an
 * operator escape hatch, not a precondition.
 */
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
  /** Override the bridge function — for testing only. */
  bridgeFn?: (
    endpointUrl: string,
    opts?: BridgeStdioToHttpMcpOptions,
  ) => Promise<{ close: () => Promise<void> }>;
}

interface BridgeStdioToHttpMcpOptions {
  stderr?: NodeJS.WritableStream;
  stdin?: Readable;
  stdout?: Writable;
  /**
   * Per-POST/DELETE request timeout in milliseconds. GET (SSE receive channel)
   * is exempted. Defaults to `DEFAULT_REQUEST_TIMEOUT_MS` (120 s).
   */
  requestTimeoutMs?: number;
  /**
   * Stable per-MCP-process connectionId. When provided, the bridge forwards
   * it on every HTTP request via `MCP_CONNECTION_ID_HEADER` so the server's
   * MCP HTTP session adopts the same id as the keepalive WS. This unifies
   * the two ids (write handlers' presence key + 3 s `bumpPresenceTs`
   * heartbeat key + on-close `clearPresence` key) so the agent presence
   * icon stays visible for the lifetime of the keepalive WS instead of
   * flickering per tool call.
   */
  connectionId?: string;
  /**
   * Called once when the bridge closes (either side). Fires before the
   * transport `.close()` awaits so process-exit paths run promptly.
   * Callers use this to detect unexpected server-side closure.
   */
  onclose?: () => void;
  /** Override the stdio transport — for testing only. */
  createStdioTransport?: (
    stdin: Readable | undefined,
    stdout: Writable | undefined,
  ) => ShimTransport;
  /** Override the HTTP transport — for testing only. */
  createHttpTransport?: (url: URL) => ShimTransport;
}

function formatHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') return 'localhost';
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

// Callers pass numeric IPv4 loopback (`DEFAULT_SERVER_HOST`), not `localhost` —
// see that constant's JSDoc for why the hostname would ECONNREFUSED on Windows.
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

/**
 * Resolve the running `ok start` server's HTTP MCP URL, auto-starting it when
 * allowed. This is deliberately only a liveness/port resolver: no MCP protocol
 * version is read or compared in the shim.
 */
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
    return mcpUrlForPort(DEFAULT_SERVER_HOST, parsed);
  }

  const existingPort = livePortFromLock(readLock(), isAlive);
  if (existingPort !== undefined) return mcpUrlForPort(DEFAULT_SERVER_HOST, existingPort);

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
          // Under the packaged .app, `self.command` is the Electron helper
          // binary; without this flag it launches as a full Electron app
          // (Dock-tile leak class). node/bun ignore it. Set explicitly so a
          // future env-scrub can't silently drop the inherited value.
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
    } catch {
      // Best-effort — some mocks may not return a real fd.
    }
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
    if (port !== undefined) return mcpUrlForPort(DEFAULT_SERVER_HOST, port);
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
  if (port !== undefined) return wsUrlForPort(DEFAULT_SERVER_HOST, port);
  return undefined;
}

/** Bridge stdio JSON-RPC frames to the server-owned Streamable HTTP MCP endpoint. */
export async function bridgeStdioToHttpMcp(
  endpointUrl: string,
  opts: BridgeStdioToHttpMcpOptions = {},
): Promise<{ close: () => Promise<void> }> {
  const stderr = opts.stderr ?? process.stderr;
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  // `as unknown as ShimTransport`: the SDK's generic `onmessage` signature is
  // structurally compatible at runtime but TypeScript's strict function types
  // can't verify the generic↔concrete assignment statically.
  const stdio: ShimTransport = opts.createStdioTransport
    ? opts.createStdioTransport(opts.stdin, opts.stdout)
    : (new StdioServerTransport(opts.stdin, opts.stdout) as unknown as ShimTransport);

  const http: ShimTransport = opts.createHttpTransport
    ? opts.createHttpTransport(new URL(endpointUrl))
    : (new StreamableHTTPClientTransport(new URL(endpointUrl), {
        fetch: makeFetchWithTimeout(requestTimeoutMs),
        requestInit: {
          headers: {
            // Client version metadata on every /mcp request (v1 wire contract),
            // alongside the existing connection-id header.
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
    // Fire before the transport awaits so process-exit callers run promptly.
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

  // `shuttingDown` is set before `bridge.close()` in the SIGINT/SIGTERM
  // handler so the `onclose` callback can distinguish a deliberate shutdown
  // (already exiting via `.finally`) from an unexpected server-side closure
  // (keepalive should stop and the process should exit).
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
        // Server died or restarted. Stop keepalive so its reconnect timer
        // doesn't keep the event loop alive while the HTTP bridge is dead,
        // then exit so the next `ok mcp` invocation resolves the new port.
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
