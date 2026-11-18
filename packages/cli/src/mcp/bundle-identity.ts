import type { ChildProcess } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { join } from 'node:path';
import { filesystemIdentity } from '@inkeep/open-knowledge-core/server';
import { RUNTIME_VERSION } from '@inkeep/open-knowledge-server';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import {
  ErrorCode,
  type JSONRPCMessage,
  type JSONRPCNotification,
  type JSONRPCRequest,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js';

export interface BundleIdentityCheckInput {
  bundleAnchorPath: string;
  currentInode: string;
  platform: NodeJS.Platform;
  realpath: (path: string) => string;
  statInode: (path: string) => string;
}

export type BundleIdentityState =
  | { kind: 'unchanged' }
  | { kind: 'replaced'; currentInode: string; onDiskInode: string }
  | { kind: 'unreadable'; reason?: string };

export function detectBundleIdentity(input: BundleIdentityCheckInput): BundleIdentityState {
  if (input.platform !== 'darwin') return { kind: 'unchanged' };

  let resolvedPath: string;
  try {
    resolvedPath = input.realpath(input.bundleAnchorPath);
  } catch (err) {
    return { kind: 'unreadable', reason: err instanceof Error ? err.message : String(err) };
  }

  let onDiskInode: string;
  try {
    onDiskInode = input.statInode(resolvedPath);
  } catch (err) {
    return { kind: 'unreadable', reason: err instanceof Error ? err.message : String(err) };
  }

  if (onDiskInode === input.currentInode) return { kind: 'unchanged' };
  return { kind: 'replaced', currentInode: input.currentInode, onDiskInode };
}

export interface BundleIdentityWatcherDeps {
  detect: () => BundleIdentityState;
  onReplaced: (state: BundleIdentityState & { kind: 'replaced' }) => void;
  log: (message: string) => void;
  intervalMs?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

export interface BundleIdentityWatcherHandle {
  stop: () => void;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export function startBundleIdentityWatcher(
  deps: BundleIdentityWatcherDeps,
): BundleIdentityWatcherHandle {
  const setIntervalFn = deps.setInterval ?? setInterval;
  const clearIntervalFn = deps.clearInterval ?? clearInterval;
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;

  let armed = true;
  let stopped = false;
  let wasUnreadable = false;

  const tick = (): void => {
    if (!armed) return;
    let state: BundleIdentityState;
    try {
      state = deps.detect();
    } catch (err) {
      deps.log(
        `bundle identity check threw unexpectedly (contract violation): ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (state.kind === 'unreadable') {
      if (!wasUnreadable) {
        wasUnreadable = true;
        deps.log(
          `bundle identity check unreadable${state.reason ? `: ${state.reason}` : ''} — will retry on next tick`,
        );
      }
      return;
    }
    if (wasUnreadable) {
      wasUnreadable = false;
      deps.log('bundle identity check recovered from unreadable');
    }
    if (state.kind === 'unchanged') return;
    armed = false;
    deps.onReplaced(state);
  };

  const handle = setIntervalFn(tick, intervalMs);
  if (typeof (handle as { unref?: unknown }).unref === 'function') {
    (handle as { unref: () => unknown }).unref();
  }

  return {
    stop: (): void => {
      if (stopped) return;
      stopped = true;
      armed = false;
      clearIntervalFn(handle);
    },
  };
}

interface CaptureBootIdentityDeps {
  realpathSync: (p: string) => string;
  statInoSync: (p: string) => string;
  log: (msg: string) => void;
}

interface BootIdentity {
  resolvedPath: string;
  inode: string;
}

export function captureBootIdentity(
  anchorPath: string,
  deps: CaptureBootIdentityDeps,
): BootIdentity | undefined {
  let resolvedPath: string;
  try {
    resolvedPath = deps.realpathSync(anchorPath);
  } catch (err) {
    deps.log(
      `[mcp] bundle identity boot capture unreadable (realpath failed): ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
  let inode: string;
  try {
    inode = deps.statInoSync(resolvedPath);
  } catch (err) {
    deps.log(
      `[mcp] bundle identity boot capture unreadable (stat failed): ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
  return { resolvedPath, inode };
}

function identityParts(identity: string): { dev: string; inode: string } {
  const separator = identity.indexOf(':');
  return { dev: identity.slice(0, separator), inode: identity.slice(separator + 1) };
}

export function formatBootIdentityLine(boot: BootIdentity, version: string): string {
  const { dev, inode } = identityParts(boot.inode);
  return `[mcp] bundle identity anchor=${boot.resolvedPath} dev=${dev} inode=${inode} version=${version}`;
}

export function formatBundleReplacedLine(
  anchorPath: string,
  state: BundleIdentityState & { kind: 'replaced' },
  version: string,
): string {
  const boot = identityParts(state.currentInode);
  const onDisk = identityParts(state.onDiskInode);
  return `[mcp] bundle replaced anchor=${anchorPath} bootDev=${boot.dev} bootInode=${boot.inode} onDiskDev=${onDisk.dev} onDiskInode=${onDisk.inode} version=${version} — handing the session to the new bundle's server`;
}

const BUNDLE_RELAY_ENV = 'OK_MCP_BUNDLE_RELAY';
const BUNDLE_HANDOVER_STATE_ENV = 'OK_MCP_HANDOVER_STATE';
const HANDOVER_STATE_METHOD = 'notifications/openknowledge/handover-state';

type HandoverState = Record<string, unknown>;

interface RelayHandover {
  readonly relayed: boolean;
  readonly state: HandoverState | undefined;
}

export function handoverStateMessage(state: HandoverState): JSONRPCMessage {
  return { jsonrpc: '2.0', method: HANDOVER_STATE_METHOD, params: { state } };
}

export function takeRelayHandover(
  env: NodeJS.ProcessEnv,
  log: (message: string) => void,
): RelayHandover {
  const relayed = env[BUNDLE_RELAY_ENV] === '1';
  const serialized = env[BUNDLE_HANDOVER_STATE_ENV];
  delete env[BUNDLE_RELAY_ENV];
  delete env[BUNDLE_HANDOVER_STATE_ENV];
  if (!relayed || serialized === undefined) return { relayed, state: undefined };
  try {
    const state: unknown = JSON.parse(serialized);
    if (isRecord(state)) return { relayed, state };
  } catch {}
  log(`[mcp] ignored an unreadable ${BUNDLE_HANDOVER_STATE_ENV} from the launching relay`);
  return { relayed, state: undefined };
}

export function relayedServerEnv(
  base: NodeJS.ProcessEnv,
  launch: SuccessorLaunch,
): NodeJS.ProcessEnv {
  return {
    ...base,
    OK_BUNDLE_PROXY: '0',
    ...(launch.relayWatches ? { [BUNDLE_RELAY_ENV]: '1' } : {}),
    ...(launch.relayWatches && launch.state !== undefined
      ? { [BUNDLE_HANDOVER_STATE_ENV]: JSON.stringify(launch.state) }
      : {}),
  };
}

function readBundleIdentity(path: string): string {
  return filesystemIdentity(statSync(path, { bigint: true }));
}

const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 20_000;
const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;
const RETIRED_SERVER_KILL_AFTER_MS = 10_000;
const REPLAY_ID_PREFIX = 'ok-bundle-handover-';
const SERVER_REQUEST_ID_PREFIX = 'ok-relay-';
const LIST_CAPABILITIES = ['tools', 'prompts', 'resources'] as const;
const BUNDLE_CLI_DIR = join('Contents', 'Resources', 'cli');
const WRAPPER_IN_CLI_DIR = join('bin', 'ok.sh');
const ENTRY_IN_CLI_DIR = join('dist', 'cli.mjs');
const BUNDLE_ENTRY = join(BUNDLE_CLI_DIR, ENTRY_IN_CLI_DIR);
export const BUNDLE_WRAPPER = join(BUNDLE_CLI_DIR, WRAPPER_IN_CLI_DIR);

export function bundleWrapperFor(entryPath: string): string | undefined {
  if (!entryPath.endsWith(`/${BUNDLE_ENTRY}`)) return undefined;
  return join(entryPath.slice(0, -ENTRY_IN_CLI_DIR.length), WRAPPER_IN_CLI_DIR);
}

export function bundleEntryFor(wrapperPath: string): string {
  return join(wrapperPath.slice(0, -WRAPPER_IN_CLI_DIR.length), ENTRY_IN_CLI_DIR);
}

interface BundleWatch {
  readonly anchorPath: string;
  readonly platform: NodeJS.Platform;
  readonly intervalMs?: number;
}

interface McpServerExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
  readonly firstServer: boolean;
  readonly answeredHost: boolean;
}

interface InProcessMcpServer {
  readonly deliver: (message: JSONRPCMessage) => void;
  readonly retire: () => void;
}

interface SuccessorLaunch {
  readonly state: HandoverState | undefined;
  readonly relayWatches: boolean;
}

interface BundleHandoverRelayOptions {
  readonly toHost: (message: JSONRPCMessage) => Promise<void>;
  readonly spawnServer: (launch: SuccessorLaunch) => ChildProcess;
  readonly watch: BundleWatch;
  readonly log: (line: string) => void;
  readonly onServerExit: (exit: McpServerExit) => void;
  readonly onUnrecoverable: () => void;
  readonly drainTimeoutMs?: number;
  readonly retryDelaysMs?: readonly number[];
}

interface BundleHandoverRelay {
  readonly fromHost: (message: JSONRPCMessage) => void;
  readonly adoptInProcess: (
    server: InProcessMcpServer,
    identity: string,
  ) => (message: JSONRPCMessage) => Promise<void>;
  readonly launchFirst: () => void;
  readonly handover: () => void;
  readonly stop: (signal?: NodeJS.Signals) => boolean;
}

interface PendingRequest {
  readonly id: RequestId;
  readonly method: string;
}

interface RelayedServer {
  readonly deliver: (message: JSONRPCMessage) => void;
  readonly retire: () => void;
  readonly child: ChildProcess | undefined;
  readonly identity: string | undefined;
  readonly pending: Map<string, PendingRequest>;
  live: boolean;
  closed: boolean;
  answeredHost: boolean;
  replayKey: string | undefined;
  onReplay: ((response: JSONRPCMessage) => void) | undefined;
  onEarlyExit: ((exit: McpServerExit) => void) | undefined;
}

interface ServerRequest {
  readonly server: RelayedServer;
  readonly id: RequestId;
  readonly relayId: string;
}

type LaunchOutcome =
  | { kind: 'ready'; server: RelayedServer; listsChanged: readonly string[] }
  | { kind: 'failed'; reason: string }
  | { kind: 'refused'; reason: string };

function keyOf(id: RequestId): string {
  return `${typeof id}:${id}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function describeExit(exit: {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}): string {
  if (exit.error !== undefined) return exit.error.message;
  if (exit.signal !== null) return `exited by signal ${exit.signal}`;
  return `exited with code ${exit.code ?? 0}`;
}

export function processExitCode(exit: {
  code: number | null;
  signal: NodeJS.Signals | null;
}): number {
  if (exit.signal !== null) return 128 + (osConstants.signals[exit.signal] ?? 0);
  return exit.code ?? 0;
}

function signalServerGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
  log: (message: string) => void,
): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH' || code === 'EPERM') return;
    log(`could not send ${signal} to the MCP server's process group ${child.pid}: ${String(err)}`);
  }
}

function updatedMidRequestError(id: RequestId): JSONRPCMessage {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: ErrorCode.InternalError,
      message:
        'OpenKnowledge was updated while this request was running, so its result was lost. Check whether it took effect, then retry it.',
    },
  };
}

function successorUnavailableError(id: RequestId, reason: string): JSONRPCMessage {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: ErrorCode.InternalError,
      message: `OpenKnowledge was updated, and its new MCP server could not start (${reason}). Reconnect the OpenKnowledge MCP server.`,
    },
  };
}

function cancelledRequestId(message: JSONRPCMessage): RequestId | undefined {
  if (!('method' in message) || message.method !== 'notifications/cancelled') return undefined;
  const requestId = message.params?.requestId;
  return typeof requestId === 'string' || typeof requestId === 'number' ? requestId : undefined;
}

function withCancelledId(message: JSONRPCMessage, requestId: RequestId): JSONRPCMessage {
  return 'method' in message && !('id' in message)
    ? { ...message, params: { ...message.params, requestId } }
    : message;
}

function protocolVersionOf(response: JSONRPCMessage): string | undefined {
  if (!('result' in response)) return undefined;
  const version = response.result.protocolVersion;
  return typeof version === 'string' ? version : undefined;
}

function changeableLists(response: JSONRPCMessage): string[] {
  if (!('result' in response)) return [];
  const capabilities = response.result.capabilities;
  if (!isRecord(capabilities)) return [];
  return LIST_CAPABILITIES.filter((list) => {
    const capability = capabilities[list];
    return isRecord(capability) && capability.listChanged === true;
  });
}

export function createBundleHandoverRelay(
  options: BundleHandoverRelayOptions,
): BundleHandoverRelay {
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const watch = options.watch;
  const log = (message: string): void => options.log(`[mcp] ${message}`);

  let current: RelayedServer | undefined;
  let retiring: RelayedServer | undefined;
  let handingOver = false;
  let stopping = false;
  let replays = 0;
  let serverRequestCount = 0;
  let watcher: BundleIdentityWatcherHandle | undefined;
  let settleDrain: ((reason: string) => void) | undefined;
  let initializeRequest: JSONRPCRequest | undefined;
  let initializedNotification: JSONRPCNotification | undefined;
  let negotiatedProtocolVersion: string | undefined;
  let handoverState: HandoverState | undefined;
  const queued: JSONRPCMessage[] = [];
  const children = new Set<ChildProcess>();
  const serverRequests = new Map<string, ServerRequest>();

  const captureIdentity = (): string | undefined =>
    captureBootIdentity(watch.anchorPath, {
      realpathSync,
      statInoSync: readBundleIdentity,
      log: options.log,
    })?.inode;

  const detect = (identity: string) =>
    detectBundleIdentity({
      bundleAnchorPath: watch.anchorPath,
      currentInode: identity,
      platform: watch.platform,
      realpath: realpathSync,
      statInode: readBundleIdentity,
    });

  const replacedSince = (identity: string | undefined): boolean =>
    identity !== undefined && detect(identity).kind === 'replaced';

  const newServer = (
    parts: Pick<RelayedServer, 'deliver' | 'retire' | 'child' | 'identity'>,
  ): RelayedServer => ({
    ...parts,
    pending: new Map(),
    live: true,
    closed: false,
    answeredHost: false,
    replayKey: undefined,
    onReplay: undefined,
    onEarlyExit: undefined,
  });

  const deliver = (server: RelayedServer, message: JSONRPCMessage): void => {
    if ('method' in message && 'id' in message) {
      server.pending.set(keyOf(message.id), { id: message.id, method: message.method });
    }
    server.deliver(message);
  };

  const routeFromHost = (message: JSONRPCMessage): void => {
    if (!('method' in message) && message.id !== undefined) {
      const request = serverRequests.get(keyOf(message.id));
      if (request !== undefined) {
        serverRequests.delete(keyOf(message.id));
        if (request.server.live) request.server.deliver({ ...message, id: request.id });
        return;
      }
    }
    const cancelledId = cancelledRequestId(message);
    if (cancelledId !== undefined) {
      const serverRequest = serverRequests.get(keyOf(cancelledId));
      if (serverRequest !== undefined) {
        serverRequests.delete(keyOf(cancelledId));
        if (serverRequest.server.live) {
          serverRequest.server.deliver(withCancelledId(message, serverRequest.id));
        }
        return;
      }
      const cancelled = keyOf(cancelledId);
      const queuedIndex = queued.findIndex(
        (queuedMessage) =>
          'method' in queuedMessage &&
          'id' in queuedMessage &&
          keyOf(queuedMessage.id) === cancelled,
      );
      if (queuedIndex !== -1) {
        queued.splice(queuedIndex, 1);
        return;
      }
      for (const server of [current, retiring]) {
        if (server?.pending.delete(cancelled)) {
          server.deliver(message);
          if (server === retiring && server.pending.size === 0)
            settleDrain?.('every request finished');
          return;
        }
      }
    }
    if (current !== undefined && !handingOver) deliver(current, message);
    else if ('method' in message && message.method === 'ping' && 'id' in message) {
      void options.toHost({ jsonrpc: '2.0', id: message.id, result: {} });
    } else queued.push(message);
  };

  const fromHost = (message: JSONRPCMessage): void => {
    if ('method' in message) {
      if (message.method === 'initialize' && 'id' in message) initializeRequest = message;
      else if (message.method === 'notifications/initialized' && !('id' in message)) {
        initializedNotification = message;
      }
    }
    routeFromHost(message);
  };

  const fromServer = (server: RelayedServer, message: JSONRPCMessage): Promise<void> => {
    if (!server.live) return Promise.resolve();
    if ('method' in message && message.method === HANDOVER_STATE_METHOD) {
      const state = message.params?.state;
      if (isRecord(state)) handoverState = state;
      return Promise.resolve();
    }
    const cancelledId = cancelledRequestId(message);
    if (cancelledId !== undefined) {
      for (const [relayKey, request] of serverRequests) {
        if (request.server !== server || keyOf(request.id) !== keyOf(cancelledId)) continue;
        serverRequests.delete(relayKey);
        server.answeredHost = true;
        return options.toHost(withCancelledId(message, request.relayId));
      }
    }
    if (!('method' in message) && message.id !== undefined) {
      const key = keyOf(message.id);
      if (key === server.replayKey) {
        server.replayKey = undefined;
        server.onReplay?.(message);
        return Promise.resolve();
      }
      const request = server.pending.get(key);
      server.pending.delete(key);
      if (request?.method === 'initialize')
        negotiatedProtocolVersion ??= protocolVersionOf(message);
      if (server === retiring && server.pending.size === 0) settleDrain?.('every request finished');
    } else if ('method' in message && 'id' in message) {
      const relayId = `${SERVER_REQUEST_ID_PREFIX}${++serverRequestCount}`;
      serverRequests.set(keyOf(relayId), { server, id: message.id, relayId });
      server.answeredHost = true;
      return options.toHost({ ...message, id: relayId });
    }
    server.answeredHost = true;
    return options.toHost(message);
  };

  const watchServer = (server: RelayedServer): void => {
    const identity = server.identity;
    if (identity === undefined) return;
    watcher = startBundleIdentityWatcher({
      detect: () => detect(identity),
      onReplaced: (state) => {
        options.log(formatBundleReplacedLine(watch.anchorPath, state, RUNTIME_VERSION));
        void handover();
      },
      log,
      ...(watch.intervalMs !== undefined ? { intervalMs: watch.intervalMs } : {}),
    });
  };

  const onChildGone = (server: RelayedServer, exit: McpServerExit): void => {
    if (server.closed) return;
    server.closed = true;
    if (server.child !== undefined) children.delete(server.child);
    const onEarlyExit = server.onEarlyExit;
    if (onEarlyExit !== undefined) {
      server.onEarlyExit = undefined;
      onEarlyExit(exit);
      return;
    }
    if (server === retiring) settleDrain?.(`the old server ${describeExit(exit)}`);
    if (server !== current) return;
    if (stopping) {
      options.onServerExit(exit);
      return;
    }
    if (handingOver) return;
    if (replacedSince(server.identity)) {
      log(`the bundle's MCP server ${describeExit(exit)} after the bundle was replaced`);
      void handover();
      return;
    }
    log(`the MCP server ${describeExit(exit)}`);
    watcher?.stop();
    watcher = undefined;
    options.onServerExit(exit);
  };

  const attachChild = (
    child: ChildProcess,
    identity: string | undefined,
    firstServer: boolean,
  ): RelayedServer => {
    children.add(child);
    const stdin = child.stdin;
    const reader = new ReadBuffer();
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const server = newServer({
      child,
      identity,
      deliver: (message) => {
        if (stdin?.writable) stdin.write(serializeMessage(message));
      },
      retire: () => {
        stdin?.end();
        killTimer = setTimeout(() => {
          if (!server.closed) signalServerGroup(child, 'SIGKILL', log);
        }, RETIRED_SERVER_KILL_AFTER_MS);
        killTimer.unref();
      },
    });
    stdin?.on('error', (err) => log(`write to the bundle's MCP server failed: ${err.message}`));
    child.stdout?.on('data', (chunk: Buffer) => {
      reader.append(chunk);
      while (true) {
        let message: JSONRPCMessage | null;
        try {
          message = reader.readMessage();
        } catch (err) {
          log(`dropped an unreadable line from the bundle's MCP server: ${String(err)}`);
          continue;
        }
        if (message === null) break;
        void fromServer(server, message);
      }
    });
    child.once('error', (error) => {
      if (child.pid === undefined) {
        onChildGone(server, { code: null, signal: null, error, firstServer, answeredHost: false });
      } else {
        log(`the bundle's MCP server reported an error: ${error.message}`);
      }
    });
    child.once('close', (code, signal) => {
      if (killTimer !== undefined) clearTimeout(killTimer);
      onChildGone(server, { code, signal, firstServer, answeredHost: server.answeredHost });
    });
    return server;
  };

  const drain = (server: RelayedServer): Promise<string> => {
    if (server.closed) return Promise.resolve('the old server had exited');
    if (server.pending.size === 0) return Promise.resolve('no request was in flight');
    const { promise, resolve } = Promise.withResolvers<string>();
    const timer = setTimeout(
      () => resolve(`the ${drainTimeoutMs}ms drain ran out`),
      drainTimeoutMs,
    );
    settleDrain = (reason) => {
      clearTimeout(timer);
      resolve(reason);
    };
    return promise.finally(() => {
      settleDrain = undefined;
    });
  };

  const launch = (): Promise<LaunchOutcome> => {
    const identity = captureIdentity();
    if (identity === undefined) {
      return Promise.resolve({
        kind: 'failed',
        reason: `could not read the identity of ${watch.anchorPath}`,
      });
    }
    let child: ChildProcess;
    try {
      child = options.spawnServer({ state: handoverState, relayWatches: true });
    } catch (err) {
      return Promise.resolve({
        kind: 'failed',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    const server = attachChild(child, identity, false);
    const initialize = initializeRequest;
    if (initialize === undefined)
      return Promise.resolve({ kind: 'ready', server, listsChanged: [] });
    const { promise, resolve } = Promise.withResolvers<LaunchOutcome>();
    const replayId = `${REPLAY_ID_PREFIX}${++replays}`;
    const abandon = (): void => {
      server.live = false;
      child.stdin?.end();
      signalServerGroup(child, 'SIGKILL', log);
    };
    const timer = setTimeout(() => {
      server.onEarlyExit = undefined;
      abandon();
      resolve({
        kind: 'failed',
        reason: `no answer to the replayed initialize request within ${READY_TIMEOUT_MS}ms`,
      });
    }, READY_TIMEOUT_MS);
    server.replayKey = keyOf(replayId);
    server.onReplay = (response) => {
      clearTimeout(timer);
      server.onEarlyExit = undefined;
      if ('error' in response) {
        abandon();
        resolve({ kind: 'refused', reason: response.error.message });
        return;
      }
      const version = protocolVersionOf(response);
      if (negotiatedProtocolVersion !== undefined && version !== negotiatedProtocolVersion) {
        abandon();
        resolve({
          kind: 'refused',
          reason: `the new server answered with MCP protocol ${version ?? 'none'} instead of the session's ${negotiatedProtocolVersion}`,
        });
        return;
      }
      if (initializedNotification !== undefined) server.deliver(initializedNotification);
      resolve({ kind: 'ready', server, listsChanged: changeableLists(response) });
    };
    server.onEarlyExit = (exit) => {
      clearTimeout(timer);
      resolve({ kind: 'failed', reason: describeExit(exit) });
    };
    server.deliver({
      ...initialize,
      id: replayId,
      params: {
        ...initialize.params,
        ...(negotiatedProtocolVersion !== undefined
          ? { protocolVersion: negotiatedProtocolVersion }
          : {}),
      },
    });
    return promise;
  };

  const startSuccessor = async (): Promise<
    { server: RelayedServer; listsChanged: readonly string[] } | string
  > => {
    let reason = 'the relay is stopping';
    for (let attempt = 0; !stopping; attempt++) {
      const outcome = await launch();
      if (outcome.kind === 'ready') return outcome;
      reason = outcome.reason;
      log(`the new bundle's MCP server did not start: ${reason}`);
      const delay = retryDelaysMs[attempt];
      if (outcome.kind === 'refused' || delay === undefined) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return reason;
  };

  const handover = async (): Promise<void> => {
    const old = current;
    if (old === undefined || handingOver || stopping) return;
    handingOver = true;
    watcher?.stop();
    watcher = undefined;
    retiring = old;
    log(
      `handing this MCP session to the new bundle's server once ${old.pending.size} in-flight request(s) finish`,
    );
    const drained = await drain(old);
    if (stopping) return;
    retiring = undefined;
    current = undefined;
    const unfinished = [...old.pending.values()];
    if (unfinished.length > 0) {
      log(
        `answered ${unfinished.length} request(s) the old server did not finish with an update error (${drained}): ${unfinished.map((request) => `${String(request.id)} ${request.method}`).join(', ')}`,
      );
    }
    for (const request of unfinished) {
      old.deliver({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: request.id, reason: 'OpenKnowledge was updated' },
      });
      void options.toHost(updatedMidRequestError(request.id));
    }
    old.pending.clear();
    old.live = false;
    old.retire();
    const next = await startSuccessor();
    if (stopping) return;
    if (typeof next === 'string') {
      for (const message of queued.splice(0)) {
        if ('method' in message && 'id' in message) {
          void options.toHost(successorUnavailableError(message.id, next));
        }
      }
      options.onUnrecoverable();
      return;
    }
    current = next.server;
    handingOver = false;
    log("the new bundle's MCP server took over this session");
    watchServer(next.server);
    for (const list of next.listsChanged) {
      void options.toHost({ jsonrpc: '2.0', method: `notifications/${list}/list_changed` });
    }
    for (const message of queued.splice(0)) routeFromHost(message);
  };

  return {
    fromHost,
    adoptInProcess: (server, identity) => {
      const adopted = newServer({
        deliver: server.deliver,
        retire: server.retire,
        child: undefined,
        identity,
      });
      current = adopted;
      return (message) => fromServer(adopted, message);
    },
    handover: () => {
      void handover();
    },
    launchFirst: () => {
      const identity = captureIdentity();
      if (identity === undefined) {
        log(
          `cannot watch ${watch.anchorPath}, so the bundle's MCP server keeps its own update watcher`,
        );
      }
      let child: ChildProcess;
      try {
        child = options.spawnServer({ state: undefined, relayWatches: identity !== undefined });
      } catch (err) {
        options.onServerExit({
          code: null,
          signal: null,
          error: err instanceof Error ? err : new Error(String(err)),
          firstServer: true,
          answeredHost: false,
        });
        return;
      }
      const first = attachChild(child, identity, true);
      current = first;
      watchServer(first);
    },
    stop: (signal) => {
      stopping = true;
      watcher?.stop();
      watcher = undefined;
      settleDrain?.('the relay is stopping');
      for (const child of children) {
        child.stdin?.end();
        if (signal !== undefined) signalServerGroup(child, signal, log);
      }
      return current?.child !== undefined && !current.closed;
    },
  };
}
