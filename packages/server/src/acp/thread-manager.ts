/**
 * Server-hosted ACP threads — one spawned agent subprocess per thread,
 * bridged to browser/Electron clients over the `/collab/thread` WS.
 *
 * Responsibilities:
 *   - Own the agent process lifecycle (spawn → initialize → session/new →
 *     prompt turns → kill on close/shutdown/idle-reap).
 *   - Implement the client side of ACP: session/update fan-out,
 *     permission requests (policy-gated via `AcpPermissionStore`), and the
 *     `fs/*` services — the attribution path that routes agent edits of
 *     in-scope markdown through the CRDT write spine instead of raw disk.
 *   - Retain a bounded per-thread event log so a reconnecting client can
 *     replay from its last-seen seq (the WS-replay analog of the
 *     "durable truth + live push" recovery contract).
 *
 * Write attribution: markdown writes reuse `AgentSessionManager` sessions
 * keyed by a per-thread `acp-<uuid>` agent id, so every edit lands under a
 * per-session frozen paired-write origin (precedent #24) and books to the
 * `agent-*` writer namespace (precedent #25) — write-flash, activity panel,
 * and per-session undo all work exactly as MCP agent writes do.
 */

import type { ChildProcess } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  client as acpClient,
  methods as acpMethods,
  type ClientConnection,
  type InitializeResponse,
  type McpServer,
  ndJsonStream,
  type PermissionOption,
  PROTOCOL_VERSION,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionNotification,
  type SessionUpdate,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import {
  AGENT_ICON_COLORS,
  changedBlockRange,
  colorFromSeed,
  type EditorId,
  iconFromClientName,
  OK_HOSTED_AGENT_ENV,
} from '@inkeep/open-knowledge-core';
import type {
  AttachmentPart,
  PiBridgeThreadState,
  PiBridgeWriteAction,
  PiTrustWriteAction,
  QueuedMessage,
  SteerMessage,
  ThreadAgentInfo,
  ThreadAuthMethod,
  ThreadEvent,
  ThreadFailureDetail,
  ThreadInfo,
  ThreadServerFrame,
  ThreadStatus,
} from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { THREAD_REOPEN_OP_TIMEOUT_MS } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { toBroadcasterKey } from '../agent-id.ts';
import type { AgentPresenceBroadcaster } from '../agent-presence.ts';
import {
  type AgentSessionManager,
  agentWriteLossDetect,
  applyAgentMarkdownWrite,
  snapshotBlocks,
} from '../agent-sessions.ts';
import { isConfigDoc, isSystemDoc } from '../cc1-broadcast.ts';
import { resolveOnPath } from '../git-preflight.ts';
import type { PinoLogger } from '../logger.ts';
import { MCP_HOSTED_AGENT_HEADER } from '../mcp/agent-identity.ts';
import { RUNTIME_VERSION } from '../version-constants.ts';
import { buildPromptBlocks } from './attachment-blocks.ts';
import { boundSessionUpdateForLog, coalesceChunkInto } from './event-log-bounds.ts';
import {
  AgentLaunchError,
  agentSpawnPath,
  brokenInterpreterHint,
  declinedRepairHint,
  envPath,
  incompatibleManagedRuntimeHint,
  incompatibleNodeHint,
  isPathQualified,
  preflightLaunch,
  probeInterpreterHealth,
  probeNpxNodeCompatibility,
  type ResolvedLaunch,
  resolveCustomLaunch,
  resolveRegistryLaunch,
  rewriteLaunchToManagedRuntime,
  spawnAcpAgent,
  terminateAgentTree,
  undeletableManagedRuntimeHint,
  unrepairableManagedRuntimeHint,
  withLoginShellPath,
  withPreferredLoginShellPath,
} from './launch.ts';
import {
  getSharedLoginShellPathProvider,
  resetSharedLoginShellPathProvider,
} from './login-shell-path.ts';
import {
  cleanupManagedRuntimeStaging,
  describeRuntime,
  ensureManagedRuntime,
  findManagedRuntime,
  type ManagedRuntime,
  type ManagedRuntimeKind,
  quarantineManagedRuntime,
  runtimeDownloadSupported,
  runtimeForInterpreter,
} from './managed-runtime.ts';
import type { AcpPermissionStore } from './permissions.ts';
import {
  ACP_AGENT_EDITOR_IDS,
  type AcpRegistry,
  type CustomAgentEntry,
  loadCustomAgents,
  registryPlatformKey,
} from './registry.ts';
import { AcpTerminalSet } from './terminals.ts';
import { type PersistedThreadMeta, ThreadPersistenceStore } from './thread-persistence.ts';
import { clampThreadTitle, deriveThreadTitle } from './thread-title.ts';

export const MAX_ACP_THREADS = 8;
export const MAX_QUEUED_PROMPTS = 20;
const EVENT_LOG_LIMIT = 5_000;
const DEFAULT_IDLE_REAP_MS = 60 * 60 * 1000;
const REAP_SWEEP_MS = 5 * 60 * 1000;
const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000;
const CONSENT_TIMEOUT_MS = 5 * 60 * 1000;

const BLOCKING_CONSENT_TIMEOUT_MS = Math.floor(THREAD_REOPEN_OP_TIMEOUT_MS / 2);
const RUNTIME_PROGRESS_THROTTLE_MS = 400;
const KILL_GRACE_MS = 5_000;
const DESTROY_KILL_GRACE_MS = 2_000;
const EVENT_FLUSH_MS = 25;
const REPLAY_CHUNK_SIZE = 512;
const DEFAULT_UNWATCHED_TURN_CANCEL_MS = 10 * 60 * 1000;
const DEFAULT_UNWATCHED_TURN_KILL_MS = 20 * 60 * 1000;
const DEFAULT_STEER_STALL_MS = 10_000;
const DEFAULT_AUTHENTICATE_TIMEOUT_MS = 5 * 60 * 1000;
const STDERR_TAIL_LINES = 40;
const SIGN_IN_OUTPUT_LINES = 6;
const RESUME_REPLAY_QUIESCENCE_MS = 300;
const RESUME_REPLAY_MAX_WAIT_MS = 3_000;
const AUTH_REQUIRED_CODE = -32000;

export const ACP_ENVIRONMENT_NOTE =
  'Note on your environment: you are running inside the OpenKnowledge app, ' +
  'connected over ACP (Agent Client Protocol) — not inside your own terminal app. ' +
  "Your host CLI's terminal UI is not present, so its built-in slash commands " +
  '(such as /tasks or /bashes) and keyboard shortcuts (such as Ctrl+O) do not ' +
  'exist here; never recommend them. The only slash commands available to the ' +
  'user are the ones you advertise over ACP.';

export class ThreadOpError extends Error {
  readonly code:
    | 'unknown-thread'
    | 'unknown-agent'
    | 'capacity'
    | 'spawn-failed'
    | 'install-failed'
    | 'not-ready'
    | 'resume-unsupported';
  constructor(code: ThreadOpError['code'], message: string) {
    super(message);
    this.name = 'ThreadOpError';
    this.code = code;
  }
}

class AuthenticateTimeoutError extends Error {
  constructor() {
    super('authenticate timed out');
    this.name = 'AuthenticateTimeoutError';
  }
}

class PromptCancelledBeforeDispatchError extends Error {
  constructor() {
    super('prompt build cancelled before dispatch');
    this.name = 'PromptCancelledBeforeDispatchError';
  }
}

function threadRestartedDuringSignIn(): ThreadOpError {
  return new ThreadOpError('not-ready', 'the thread was restarted during the sign-in');
}

type Subscriber = (frame: ThreadServerFrame) => void;

interface PendingConsent {
  resolve: (decision: 'granted' | 'declined' | 'timeout' | 'closed') => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ThreadRecord {
  info: ThreadInfo;
  docName?: string;
  agentRef: { source: 'registry' | 'custom'; id: string };
  launchSettings?: { config?: Record<string, string | boolean>; modeId?: string };
  cwd: string;
  child: ChildProcess | null;
  conn: ClientConnection | null;
  lastInit: InitializeResponse | null;
  sessionId: string | null;
  agentSessionId: string;
  events: ThreadEvent[];
  baseSeq: number;
  logResolved: boolean;
  logResolution: Promise<void> | null;
  midTurnOnDisk: boolean;
  resumeInFlight: boolean;
  authInFlight: boolean;
  suppressUpdates: boolean;
  lastSuppressedAt: number;
  subscribers: Set<Subscriber>;
  pendingPermissions: Map<
    string,
    { resolve: (response: RequestPermissionResponse) => void; timer: ReturnType<typeof setTimeout> }
  >;
  pendingRuntimeConsent: Map<string, PendingConsent>;
  pendingPiBridgeConsent: Map<string, PendingConsent>;
  piBridgeDeclined: boolean;
  lastPiBridgeStatus: PiBridgeThreadState | null;
  stderrTail: string[];
  authStderr: string[] | null;
  terminals: AcpTerminalSet | null;
  turnActive: boolean;
  cancelRequested: boolean;
  steerStallTimer: ReturnType<typeof setTimeout> | null;
  unwatchedSince: number | null;
  unwatchedCancelSent: boolean;
  pendingBroadcast: ThreadEvent[];
  pendingBroadcastFromSeq: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
  hadUserMessage: boolean;
  titleHint?: string;
  envNotePending: boolean;
}

export interface HarnessManagedMcpEntryHit {
  editorId: EditorId;
  scope: 'project' | 'user';
  configPath: string;
}

export interface PiAcpBridgeProbe {
  bridgePath: string;
  bridge: 'absent' | 'own-current' | 'own-stale' | 'foreign' | 'unreadable';
  trust: 'trusted' | 'untrusted' | 'unreadable';
  bridgeLoadable: boolean;
  otherExtensions: readonly string[];
}

export interface PiAcpBridgeEnsureResult {
  ok: boolean;
  bridgePath: string;
  bridge: PiBridgeWriteAction;
  trust: PiTrustWriteAction;
  error?: string;
}

type PiBridgeOutcome = 'loadable' | 'unavailable' | 'unknown';

function isPiBridgeAgent(agentRef: { source: 'registry' | 'custom'; id: string }): boolean {
  return agentRef.source === 'registry' && ACP_AGENT_EDITOR_IDS[agentRef.id] === 'pi';
}

export interface AcpThreadManagerOptions {
  contentDir: string;
  localDir: string;
  globalDir: string | null;
  registry: AcpRegistry;
  permissions: AcpPermissionStore;
  sessionManager: AgentSessionManager;
  agentPresenceBroadcaster?: AgentPresenceBroadcaster | null;
  resolveEmbed?: (basename: string, sourcePath: string) => string | null;
  isExcludedPath: (relPath: string) => boolean;
  isIgnoredPath: (relPosix: string) => boolean;
  getLoadedDocText?: (docName: string) => string | null;
  getServerUrl?: () => string;
  getMcpStdioCommand?: () => { command: string; args: readonly string[] } | null | undefined;
  probeHarnessManagedMcpEntry?: (
    editorId: EditorId,
    cwd: string,
  ) => HarnessManagedMcpEntryHit | null | Promise<HarnessManagedMcpEntryHit | null>;
  probePiAcpBridge?: (cwd: string) => PiAcpBridgeProbe | Promise<PiAcpBridgeProbe>;
  ensurePiAcpBridge?: (cwd: string) => PiAcpBridgeEnsureResult | Promise<PiAcpBridgeEnsureResult>;
  runtimeInstall?: {
    root?: string;
    fetchImpl?: typeof fetch;
  };
  resolveLoginShellPath?: () => Promise<string | null>;
  log: PinoLogger;
  maxThreads?: number;
  idleReapMs?: number;
  steerStallMs?: number;
  authenticateTimeoutMs?: number;
  unwatchedTurnCancelMs?: number;
  unwatchedTurnKillMs?: number;
}

export function buildOkMcpStdioCommand(
  localOpCliArgs: readonly string[] | undefined,
  port: number,
  deps?: {
    resolveCommand?: (name: string) => string | null;
    log?: PinoLogger;
  },
): { command: string; args: string[] } {
  const argv = localOpCliArgs && localOpCliArgs.length > 0 ? localOpCliArgs : ['open-knowledge'];
  const [command = 'open-knowledge', ...rest] = argv;
  const args = [...rest, 'mcp', '--port', String(port)];
  if (command.includes('/') || command.includes('\\')) return { command, args };
  const resolved = (deps?.resolveCommand ?? ((name) => resolveOnPath(name, agentSpawnPath())))(
    command,
  );
  if (resolved === null) {
    deps?.log?.warn(
      { command },
      '[acp-threads] OK MCP stdio command did not resolve on PATH — injecting the bare name, which fails for harnesses that spawn MCP children under a minimal PATH',
    );
    return { command, args };
  }
  return { command: resolved, args };
}

export type OkMcpHostedMarker = 'http-header' | 'stdio-entry-env' | 'unknown' | 'none';

interface InterpreterProbeFailure {
  kind: 'unhealthy' | 'incompatible';
  detail: string;
}

export class AcpThreadManager {
  private readonly opts: AcpThreadManagerOptions;
  private readonly threads = new Map<string, ThreadRecord>();
  private readonly reapTimer: ReturnType<typeof setInterval>;
  private readonly maxThreads: number;
  private readonly idleReapMs: number;
  private readonly steerStallMs: number;
  private readonly authenticateTimeoutMs: number;
  private readonly unwatchedTurnCancelMs: number;
  private readonly unwatchedTurnKillMs: number;
  private readonly persistence: ThreadPersistenceStore;
  private readonly resolveLoginShellPath: () => Promise<string | null>;
  private readonly healthyInterpreters = new Set<string>();
  private destroyed = false;
  private initialized = false;

  constructor(opts: AcpThreadManagerOptions) {
    this.opts = opts;
    this.resolveLoginShellPath =
      opts.resolveLoginShellPath ?? (() => getSharedLoginShellPathProvider(opts.log)());
    this.maxThreads = opts.maxThreads ?? MAX_ACP_THREADS;
    this.idleReapMs = opts.idleReapMs ?? DEFAULT_IDLE_REAP_MS;
    this.steerStallMs = opts.steerStallMs ?? DEFAULT_STEER_STALL_MS;
    this.authenticateTimeoutMs = opts.authenticateTimeoutMs ?? DEFAULT_AUTHENTICATE_TIMEOUT_MS;
    this.unwatchedTurnCancelMs = opts.unwatchedTurnCancelMs ?? DEFAULT_UNWATCHED_TURN_CANCEL_MS;
    this.unwatchedTurnKillMs = opts.unwatchedTurnKillMs ?? DEFAULT_UNWATCHED_TURN_KILL_MS;
    this.persistence = new ThreadPersistenceStore({
      primaryDir: opts.globalDir ?? opts.localDir,
      legacyDir: opts.globalDir !== null ? opts.localDir : null,
      cwd: opts.globalDir !== null ? opts.contentDir : null,
      log: opts.log,
    });
    this.reapTimer = setInterval(() => this.reapIdleThreads(), REAP_SWEEP_MS);
    this.reapTimer.unref?.();
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    void this.resolveLoginShellPath().catch(() => {});
    await this.persistence.init();
    const metas = await this.persistence.scan();
    for (const meta of metas) {
      const threadId = meta.info.threadId;
      if (this.threads.has(threadId)) continue;
      this.threads.set(threadId, rehydratedRecord(meta));
    }
    if (metas.length > 0) {
      this.opts.log.info({ count: metas.length }, '[acp-threads] rehydrated archived threads');
    }
  }

  listThreads(): ThreadInfo[] {
    return [...this.threads.values()].map((t) => ({ ...t.info }));
  }

  private liveThreadCount(): number {
    let count = 0;
    for (const t of this.threads.values()) {
      if (t.info.archived !== true) count += 1;
    }
    return count;
  }

  getInfo(threadId: string): ThreadInfo | undefined {
    const t = this.threads.get(threadId);
    return t === undefined ? undefined : { ...t.info };
  }

  async subscribe(threadId: string, sinceSeq: number, sink: Subscriber): Promise<ThreadInfo> {
    const t = this.mustGet(threadId);
    await this.ensureLogResolved(t);
    const from = Math.max(sinceSeq, 0);
    sink({ op: 'subscribed', threadId, fromSeq: from, info: { ...t.info } });
    let diskCursor = from;
    while (diskCursor < t.baseSeq) {
      const target = t.baseSeq;
      await this.persistence.whenIdle(threadId);
      await this.persistence.readEvents(threadId, diskCursor, target, (chunkFrom, events) => {
        sink({ op: 'events', threadId, fromSeq: chunkFrom, events });
      });
      diskCursor = target;
    }
    this.flushBroadcast(t);
    const memFrom = Math.max(from, t.baseSeq);
    const end = t.baseSeq + t.events.length;
    for (let chunkStart = memFrom; chunkStart < end; chunkStart += REPLAY_CHUNK_SIZE) {
      const chunkEnd = Math.min(chunkStart + REPLAY_CHUNK_SIZE, end);
      sink({
        op: 'events',
        threadId,
        fromSeq: chunkStart,
        events: t.events.slice(chunkStart - t.baseSeq, chunkEnd - t.baseSeq),
      });
    }
    t.subscribers.add(sink);
    t.unwatchedSince = null;
    t.unwatchedCancelSent = false;
    return { ...t.info };
  }

  private ensureLogResolved(t: ThreadRecord): Promise<void> {
    if (t.logResolved) return Promise.resolve();
    t.logResolution ??= (async () => {
      try {
        const resolved = await this.persistence.resolveEventLog(t.info.threadId);
        t.baseSeq = resolved.count;
        t.midTurnOnDisk = resolved.midTurn;
        t.info.lastSeq = resolved.count - 1;
        t.logResolved = true;
      } catch (err) {
        t.logResolution = null;
        this.opts.log.error(
          { err, threadId: t.info.threadId },
          '[acp-threads] durable log resolution failed',
        );
        throw err;
      }
    })();
    return t.logResolution;
  }

  unsubscribe(threadId: string, sink: Subscriber): void {
    const t = this.threads.get(threadId);
    if (t === undefined) return;
    t.subscribers.delete(sink);
    if (t.subscribers.size === 0 && t.unwatchedSince === null) {
      t.unwatchedSince = Date.now();
    }
  }

  async createThread(params: {
    agent: { source: 'registry' | 'custom'; id: string };
    prompt?: string;
    attachments?: readonly AttachmentPart[];
    docName?: string;
    titleHint?: string;
    settings?: { config?: Record<string, string | boolean>; modeId?: string };
  }): Promise<ThreadInfo> {
    if (this.destroyed) throw new ThreadOpError('capacity', 'server is shutting down');
    if (this.liveThreadCount() >= this.maxThreads) {
      throw new ThreadOpError('capacity', `maximum of ${this.maxThreads} concurrent agent threads`);
    }

    const { info: agentInfo, custom } = await this.resolveAgentInfo(params.agent);
    if (this.destroyed) throw new ThreadOpError('capacity', 'server is shutting down');
    if (this.liveThreadCount() >= this.maxThreads) {
      throw new ThreadOpError('capacity', `maximum of ${this.maxThreads} concurrent agent threads`);
    }
    const threadId = crypto.randomUUID();
    const now = Date.now();
    const record: ThreadRecord = {
      info: {
        threadId,
        agent: agentInfo,
        title: agentInfo.name,
        status: 'installing',
        createdAt: now,
        lastActivityAt: now,
        promptCapabilities: null,
        modes: null,
        configOptions: null,
        availableCommands: null,
        lastSeq: -1,
        archived: false,
      },
      docName: params.docName,
      agentRef: { source: params.agent.source, id: params.agent.id },
      launchSettings: params.settings,
      cwd: this.opts.contentDir,
      child: null,
      conn: null,
      lastInit: null,
      sessionId: null,
      agentSessionId: `acp-${threadId}`,
      events: [],
      baseSeq: 0,
      logResolved: true,
      logResolution: null,
      midTurnOnDisk: false,
      resumeInFlight: false,
      authInFlight: false,
      suppressUpdates: false,
      lastSuppressedAt: 0,
      subscribers: new Set(),
      pendingPermissions: new Map(),
      pendingRuntimeConsent: new Map(),
      pendingPiBridgeConsent: new Map(),
      piBridgeDeclined: false,
      lastPiBridgeStatus: null,
      stderrTail: [],
      authStderr: null,
      terminals: null,
      turnActive: false,
      cancelRequested: false,
      steerStallTimer: null,
      unwatchedSince: now,
      unwatchedCancelSent: false,
      pendingBroadcast: [],
      pendingBroadcastFromSeq: 0,
      flushTimer: null,
      closed: false,
      hadUserMessage: false,
      titleHint: params.titleHint,
      envNotePending: false,
    };
    this.threads.set(threadId, record);
    this.emitStatus(record, 'installing');

    void this.startThread(record, params, custom).catch((err) => {
      this.opts.log.error({ err, threadId }, '[acp-threads] thread start failed');
      this.emitStatus(record, 'error', err instanceof Error ? err.message : String(err));
    });

    return { ...record.info };
  }

  private async resolveAgentInfo(agent: {
    source: 'registry' | 'custom';
    id: string;
  }): Promise<{ info: ThreadAgentInfo; custom: CustomAgentEntry | null }> {
    if (agent.source === 'custom') {
      const custom = (await loadCustomAgents(this.opts.localDir, this.opts.log)).find(
        (c) => c.id === agent.id,
      );
      if (custom === undefined) {
        throw new ThreadOpError('unknown-agent', `no custom agent '${agent.id}'`);
      }
      return { info: { id: custom.id, name: custom.name, source: 'custom' }, custom };
    }
    let manifest: Awaited<ReturnType<AcpRegistry['getAgent']>>;
    try {
      manifest = await this.opts.registry.getAgent(agent.id);
    } catch (err) {
      throw new ThreadOpError(
        'install-failed',
        `agent registry unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (manifest === undefined) {
      throw new ThreadOpError('unknown-agent', `agent '${agent.id}' is not in the registry`);
    }
    return {
      info: {
        id: manifest.id,
        name: manifest.name,
        iconUrl: manifest.icon,
        source: 'registry',
        version: manifest.version,
      },
      custom: null,
    };
  }

  private async connectAgent(
    record: ThreadRecord,
    custom: CustomAgentEntry | null,
  ): Promise<{ conn: ClientConnection; init: InitializeResponse; launch: ResolvedLaunch } | null> {
    let launch: ResolvedLaunch;
    if (custom !== null) {
      launch = resolveCustomLaunch(custom);
    } else {
      const manifest = await this.opts.registry.getAgent(record.agentRef.id);
      if (manifest === undefined) throw new ThreadOpError('unknown-agent', 'agent vanished');
      launch = await resolveRegistryLaunch(manifest, registryPlatformKey(), this.opts.log);
    }
    if (record.closed) return null;

    const launchable = await this.ensureLaunchable(record, launch);
    if (launchable === null) return null;
    launch = launchable;
    if (record.closed) return null;

    const loginShellPath = await this.resolveLoginShellPath().catch(() => null);
    if (record.closed) return null;

    const terminals = new AcpTerminalSet({
      defaultCwd: record.cwd,
      emit: (event) => this.appendEvent(record, event),
      log: this.opts.log,
      loginShellPath,
    });

    this.emitStatus(record, 'spawning');
    const child = spawnAcpAgent(launch, record.cwd);
    record.child = child;
    record.terminals = terminals;

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim() === '') continue;
        record.stderrTail.push(line.slice(0, 500));
        if (record.stderrTail.length > STDERR_TAIL_LINES) record.stderrTail.shift();
        if (record.authStderr !== null) {
          record.authStderr.push(line.slice(0, 500));
          if (record.authStderr.length > SIGN_IN_OUTPUT_LINES) record.authStderr.shift();
          record.info.signInOutput = [...record.authStderr];
          this.broadcastInfo(record);
        }
      }
    });
    child.on('error', (err) => {
      this.emitStatus(record, 'error', `agent failed to start: ${err.message}`, {
        reason: 'connect',
        agentMessage: err.message,
      });
    });
    child.on('exit', (code, signal) => {
      record.child = null;
      terminals.disposeAll().catch((err: unknown) => {
        this.opts.log.warn(
          { err, threadId: record.info.threadId },
          '[acp-threads] terminal cleanup on agent exit failed',
        );
      });
      if (record.closed || record.info.archived === true) return;
      if (record.info.status === 'error') {
        this.failPendingPermissions(record);
        return;
      }
      const tail = record.stderrTail.slice(-10).join('\n');
      this.opts.log.warn(
        {
          threadId: record.info.threadId,
          agentId: record.info.agent.id,
          code,
          signal,
          machineDetail: stderrTailDetail(record),
        },
        '[acp-threads] agent exited unexpectedly',
      );
      this.emitStatus(
        record,
        'exited',
        `agent exited (${signal ?? code ?? 'unknown'})${tail ? `\n${tail}` : ''}`,
      );
      this.failPendingPermissions(record);
    });

    if (child.stdin === null || child.stdout === null) {
      throw new ThreadOpError('spawn-failed', 'agent process has no stdio');
    }
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    );

    const conn = acpClient({ name: 'open-knowledge' })
      .onRequest(acpMethods.client.session.requestPermission, (ctx) =>
        this.handlePermissionRequest(record, ctx.params.toolCall, ctx.params.options),
      )
      .onRequest(acpMethods.client.fs.readTextFile, (ctx) =>
        this.handleFsRead(ctx.params.path, ctx.params.line ?? null, ctx.params.limit ?? null),
      )
      .onRequest(acpMethods.client.fs.writeTextFile, async (ctx) => {
        await this.handleFsWrite(record, ctx.params.path, ctx.params.content);
        return {};
      })
      .onRequest(acpMethods.client.terminal.create, (ctx) => {
        record.info.lastActivityAt = Date.now();
        return terminals.create(ctx.params);
      })
      .onRequest(acpMethods.client.terminal.output, (ctx) =>
        terminals.output(ctx.params.terminalId),
      )
      .onRequest(acpMethods.client.terminal.waitForExit, (ctx) =>
        terminals.waitForExit(ctx.params.terminalId),
      )
      .onRequest(acpMethods.client.terminal.kill, async (ctx) => {
        await terminals.kill(ctx.params.terminalId);
        return {};
      })
      .onRequest(acpMethods.client.terminal.release, async (ctx) => {
        await terminals.release(ctx.params.terminalId);
        return {};
      })
      .onNotification(acpMethods.client.session.update, (ctx) =>
        this.handleSessionUpdate(record, ctx.params),
      )
      .connect(stream);
    record.conn = conn;
    conn.closed.then(
      () => {
        if (
          !record.closed &&
          record.info.archived !== true &&
          record.info.status !== 'exited' &&
          record.info.status !== 'error'
        ) {
          this.emitStatus(record, 'exited', 'agent connection closed');
        }
      },
      (err: unknown) => {
        this.opts.log.warn(
          { err, threadId: record.info.threadId },
          '[acp-threads] agent connection closed with error',
        );
        if (
          !record.closed &&
          record.info.archived !== true &&
          record.info.status !== 'exited' &&
          record.info.status !== 'error'
        ) {
          this.emitStatus(
            record,
            'error',
            `agent connection failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    );

    let init: InitializeResponse;
    try {
      init = await conn.agent.request(acpMethods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'open-knowledge', title: 'Open Knowledge', version: RUNTIME_VERSION },
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
          session: { configOptions: { boolean: {} } },
        },
      });
    } catch (err) {
      this.opts.log.warn(
        { err, threadId: record.info.threadId },
        '[acp-threads] initialize failed',
      );
      throw new ThreadOpError('spawn-failed', `initialize failed: ${agentErrorMessage(err)}`);
    }
    if (record.closed) return null;
    record.lastInit = init;
    record.info.promptCapabilities = init.agentCapabilities?.promptCapabilities ?? {};
    this.emitInfo(record);
    return { conn, init, launch };
  }

  private async ensureLaunchable(
    record: ThreadRecord,
    launch: ResolvedLaunch,
  ): Promise<ResolvedLaunch | null> {
    let candidate: ResolvedLaunch;
    try {
      await preflightLaunch(launch);
      candidate = await this.withLoginShellPathIfEligible(launch);
    } catch (err) {
      if (!(err instanceof AgentLaunchError) || err.code !== 'command-not-found') throw err;
      const viaLoginShell = await this.retryWithLoginShellPath(launch);
      if (viaLoginShell === null) return this.fallbackToManagedRuntime(record, launch, err);
      candidate = viaLoginShell;
    }
    if (record.closed) return null;
    return this.ensureInterpreterRuns(record, candidate);
  }

  private async ensureInterpreterRuns(
    record: ThreadRecord,
    launch: ResolvedLaunch,
  ): Promise<ResolvedLaunch | null> {
    if (launch.kind !== 'npx' && launch.kind !== 'uvx') return launch;
    const failure = await this.probeInterpreterOnce(launch);
    if (record.closed) return null;
    if (failure === null) return launch;

    if (failure.kind === 'incompatible') {
      const preferred = await this.withPreferredLoginShellPathIfEligible(launch);
      if (record.closed) return null;
      if (envPath(preferred.env) !== envPath(launch.env)) {
        try {
          await preflightLaunch(preferred);
          const preferredFailure = await this.probeInterpreterOnce(preferred);
          if (record.closed) return null;
          if (preferredFailure === null) {
            this.opts.log.info(
              { threadId: record.info.threadId, agentId: record.info.agent.id },
              '[acp-threads] compatible Node resolved via the preferred login-shell PATH',
            );
            return preferred;
          }
          this.opts.log.debug(
            {
              threadId: record.info.threadId,
              agentId: record.info.agent.id,
              cmd: preferred.cmd,
              kind: preferred.kind,
              failureKind: preferredFailure.kind,
              detail: preferredFailure.detail,
            },
            '[acp-threads] preferred login-shell PATH did not provide a compatible Node',
          );
        } catch (err) {
          if (!(err instanceof AgentLaunchError) || err.code !== 'command-not-found') throw err;
        }
      }
    }

    this.opts.log.warn(
      {
        threadId: record.info.threadId,
        agentId: record.info.agent.id,
        cmd: launch.cmd,
        kind: launch.kind,
        failureKind: failure.kind,
        detail: failure.detail,
      },
      '[acp-threads] interpreter cannot run this agent — offering the managed runtime',
    );
    const cause = new AgentLaunchError(
      'command-not-found',
      failure.kind === 'incompatible'
        ? incompatibleNodeHint(launch, failure.detail)
        : brokenInterpreterHint(launch, failure.detail),
    );
    return this.fallbackToManagedRuntime(record, launch, cause, cause);
  }

  private async fallbackToManagedRuntime(
    record: ThreadRecord,
    launch: ResolvedLaunch,
    cause: AgentLaunchError,
    declineCause?: AgentLaunchError,
  ): Promise<ResolvedLaunch | null> {
    if (launch.kind !== 'npx' && launch.kind !== 'uvx') throw cause;
    const runtimeKind = runtimeForInterpreter(launch.kind);
    if (!runtimeDownloadSupported(runtimeKind)) throw cause;
    const runtime = await this.provideManagedRuntime(
      record,
      runtimeKind,
      declineCause === undefined ? 'missing' : 'broken',
    ).catch((err: unknown) => {
      if (declineCause !== undefined && err instanceof AgentLaunchError) {
        throw err.code === 'command-not-found' ? declineCause : err;
      }
      throw err;
    });
    if (runtime === null) return null;
    const rewritten = rewriteLaunchToManagedRuntime(launch, runtime);
    await preflightLaunch(rewritten);
    const brokenManaged = await this.probeInterpreterOnce(rewritten);
    if (brokenManaged === null) return rewritten;
    if (brokenManaged.kind === 'incompatible') {
      throw new AgentLaunchError(
        'install-failed',
        incompatibleManagedRuntimeHint(brokenManaged.detail),
      );
    }
    return this.repairManagedRuntime(record, launch, runtimeKind, brokenManaged.detail);
  }

  private async repairManagedRuntime(
    record: ThreadRecord,
    launch: ResolvedLaunch,
    runtimeKind: ManagedRuntimeKind,
    detail: string,
  ): Promise<ResolvedLaunch | null> {
    const logContext = {
      threadId: record.info.threadId,
      agentId: record.info.agent.id,
      runtime: runtimeKind,
      detail,
    };
    this.opts.log.warn(
      logContext,
      "[acp-threads] OK's own managed runtime failed to run — replacing it",
    );
    const cleared = await quarantineManagedRuntime(
      runtimeKind,
      this.opts.log,
      this.opts.runtimeInstall?.root,
    );
    if (!cleared) {
      throw new AgentLaunchError('install-failed', undeletableManagedRuntimeHint(launch, detail));
    }

    const fresh = await this.provideManagedRuntime(record, runtimeKind, 'damaged').catch(
      (err: unknown) => {
        if (err instanceof AgentLaunchError && err.code === 'command-not-found') {
          throw new AgentLaunchError('command-not-found', declinedRepairHint(launch));
        }
        throw err;
      },
    );
    if (fresh === null) return null;
    const rewritten = rewriteLaunchToManagedRuntime(launch, fresh);
    await preflightLaunch(rewritten);
    const stillBroken = await this.probeInterpreterOnce(rewritten);
    if (stillBroken === null) return rewritten;
    this.opts.log.error(
      { ...logContext, detail: stillBroken.detail },
      '[acp-threads] a freshly downloaded managed runtime failed to run',
    );
    throw new AgentLaunchError(
      'install-failed',
      stillBroken.kind === 'incompatible'
        ? incompatibleManagedRuntimeHint(stillBroken.detail)
        : unrepairableManagedRuntimeHint(rewritten, stillBroken.detail),
    );
  }

  private async probeInterpreterOnce(
    launch: ResolvedLaunch,
  ): Promise<InterpreterProbeFailure | null> {
    const healthKey = JSON.stringify([launch.cmd, envPath(launch.env) ?? '']);
    if (this.healthyInterpreters.has(healthKey)) return null;
    const unhealthyDetail = await probeInterpreterHealth(launch, undefined, this.opts.log);
    if (unhealthyDetail !== null) return { kind: 'unhealthy', detail: unhealthyDetail };
    if (launch.kind === 'npx') {
      const incompatibleDetail = await probeNpxNodeCompatibility(launch, undefined, this.opts.log);
      if (incompatibleDetail !== null) {
        return { kind: 'incompatible', detail: incompatibleDetail };
      }
    }
    this.healthyInterpreters.add(healthKey);
    return null;
  }

  private async retryWithLoginShellPath(launch: ResolvedLaunch): Promise<ResolvedLaunch | null> {
    const retry = await this.withLoginShellPathIfEligible(launch);
    if (envPath(retry.env) === envPath(launch.env)) return null;
    try {
      await preflightLaunch(retry);
    } catch (err) {
      if (!(err instanceof AgentLaunchError)) throw err;
      this.opts.log.debug(
        { cmd: launch.cmd, kind: launch.kind },
        '[acp] login-shell PATH did not resolve the command either',
      );
      return null;
    }
    this.opts.log.info(
      { cmd: launch.cmd, kind: launch.kind },
      '[acp] command resolved via the login-shell PATH; skipping the managed-runtime offer',
    );
    return retry;
  }

  private async withLoginShellPathIfEligible(launch: ResolvedLaunch): Promise<ResolvedLaunch> {
    if (launch.pathFromOverlay || isPathQualified(launch.cmd)) return launch;
    const loginShellPath = await this.resolveLoginShellPath().catch(() => null);
    if (loginShellPath === null) return launch;
    return withLoginShellPath(launch, loginShellPath);
  }

  private async withPreferredLoginShellPathIfEligible(
    launch: ResolvedLaunch,
  ): Promise<ResolvedLaunch> {
    if (launch.pathFromOverlay || isPathQualified(launch.cmd)) return launch;
    const loginShellPath = await this.resolveLoginShellPath().catch(() => null);
    if (loginShellPath === null) return launch;
    return withPreferredLoginShellPath(launch, loginShellPath);
  }

  private async provideManagedRuntime(
    record: ThreadRecord,
    runtimeKind: ManagedRuntimeKind,
    reason: 'missing' | 'broken' | 'damaged',
  ): Promise<ManagedRuntime | null> {
    const root = this.opts.runtimeInstall?.root;
    await cleanupManagedRuntimeStaging(runtimeKind, this.opts.log, root);
    const existing = await findManagedRuntime(runtimeKind, root).catch(() => null);
    if (existing !== null) return existing;

    const decision = await this.requestRuntimeConsent(record, runtimeKind, reason);
    if (decision === 'closed' || record.closed) return null;
    if (decision !== 'granted') {
      throw new AgentLaunchError('command-not-found', declinedRuntimeHint(runtimeKind));
    }

    try {
      const runtime = await this.downloadRuntime(record, runtimeKind);
      return record.closed ? null : runtime;
    } catch (err) {
      const name = describeRuntime(runtimeKind).displayName;
      throw new AgentLaunchError(
        'install-failed',
        `couldn't install ${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private requestRuntimeConsent(
    record: ThreadRecord,
    runtimeKind: ManagedRuntimeKind,
    reason: 'missing' | 'broken' | 'damaged',
  ): Promise<'granted' | 'declined' | 'timeout' | 'closed'> {
    const requestId = crypto.randomUUID();
    const d = describeRuntime(runtimeKind);
    this.appendEvent(record, {
      kind: 'runtime_consent_request',
      requestId,
      runtime: runtimeKind,
      displayName: d.displayName,
      provides: d.provides,
      version: d.version,
      approxSizeMB: d.approxSizeMB,
      sourceHost: d.sourceHost,
      agentName: record.info.agent.name,
      reason,
      ts: Date.now(),
    });
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        record.pendingRuntimeConsent.delete(requestId);
        this.appendEvent(record, {
          kind: 'runtime_consent_resolved',
          requestId,
          decision: 'timeout',
          ts: Date.now(),
        });
        resolvePromise('timeout');
      }, CONSENT_TIMEOUT_MS);
      timer.unref?.();
      record.pendingRuntimeConsent.set(requestId, { resolve: resolvePromise, timer });
    });
  }

  respondRuntimeConsent(
    threadId: string,
    requestId: string,
    outcome: { kind: 'granted' } | { kind: 'declined' },
  ): void {
    const t = this.mustGet(threadId);
    const pending = t.pendingRuntimeConsent.get(requestId);
    if (pending === undefined) return;
    t.pendingRuntimeConsent.delete(requestId);
    clearTimeout(pending.timer);
    const decision = outcome.kind === 'granted' ? 'granted' : 'declined';
    this.appendEvent(t, {
      kind: 'runtime_consent_resolved',
      requestId,
      decision,
      ts: Date.now(),
    });
    pending.resolve(decision);
  }

  private async downloadRuntime(
    record: ThreadRecord,
    runtimeKind: ManagedRuntimeKind,
  ): Promise<ManagedRuntime> {
    this.emitStatus(record, 'installing');
    let lastProgressAt = 0;
    return ensureManagedRuntime(runtimeKind, this.opts.log, {
      root: this.opts.runtimeInstall?.root,
      fetchImpl: this.opts.runtimeInstall?.fetchImpl,
      onProgress: (p) => {
        const now = Date.now();
        if (now - lastProgressAt < RUNTIME_PROGRESS_THROTTLE_MS) return;
        lastProgressAt = now;
        if (record.closed) return;
        this.appendEvent(record, {
          kind: 'runtime_install_progress',
          runtime: runtimeKind,
          phase: 'downloading',
          receivedBytes: p.receivedBytes,
          totalBytes: p.totalBytes ?? undefined,
          ts: now,
        });
      },
    });
  }

  private async buildMcpServers(
    record: ThreadRecord,
    init: InitializeResponse,
    consentBudgetMs: number = CONSENT_TIMEOUT_MS,
  ): Promise<{ servers: McpServer[]; hostedMarker: OkMcpHostedMarker }> {
    const servers: McpServer[] = [];
    let hostedMarker: OkMcpHostedMarker;
    if (isPiBridgeAgent(record.agentRef)) {
      const outcome = await this.settlePiBridge(record, consentBudgetMs);
      hostedMarker = outcome === 'unavailable' ? 'none' : 'unknown';
    } else if ((await this.harnessAlreadyHasOkMcp(record)) !== null) {
      hostedMarker = 'unknown';
    } else {
      const serverUrl = this.opts.getServerUrl?.();
      if (serverUrl !== undefined && init.agentCapabilities?.mcpCapabilities?.http === true) {
        servers.push({
          type: 'http',
          name: 'open-knowledge',
          url: `${serverUrl}/mcp`,
          headers: [{ name: MCP_HOSTED_AGENT_HEADER, value: '1' }],
        });
        hostedMarker = 'http-header';
      } else {
        const stdio = this.opts.getMcpStdioCommand?.();
        const entryPath = agentSpawnPath();
        if (stdio !== null && stdio !== undefined) {
          servers.push({
            name: 'open-knowledge',
            command: stdio.command,
            args: [...stdio.args],
            env: [
              { name: OK_HOSTED_AGENT_ENV, value: '1' },
              ...(entryPath !== undefined && entryPath !== ''
                ? [{ name: 'PATH', value: entryPath }]
                : []),
            ],
          });
          hostedMarker = 'stdio-entry-env';
        } else {
          hostedMarker = 'none';
        }
      }
    }
    if (hostedMarker === 'none') {
      this.opts.log.warn(
        { threadId: record.info.threadId, agentId: record.agentRef.id },
        '[acp-threads] no OK MCP transport available for this agent — it starts without OK tools',
      );
    } else {
      this.opts.log.info(
        { threadId: record.info.threadId, agentId: record.agentRef.id, hostedMarker },
        '[acp-threads] OK MCP injection outcome',
      );
    }
    return { servers, hostedMarker };
  }

  private async harnessAlreadyHasOkMcp(
    record: ThreadRecord,
  ): Promise<HarnessManagedMcpEntryHit | null> {
    const probe = this.opts.probeHarnessManagedMcpEntry;
    if (probe === undefined || record.agentRef.source !== 'registry') return null;
    const editorId = ACP_AGENT_EDITOR_IDS[record.agentRef.id];
    if (editorId === undefined) return null;
    let hit: HarnessManagedMcpEntryHit | null;
    try {
      hit = await probe(editorId, record.cwd);
    } catch (err) {
      this.opts.log.warn(
        { err, threadId: record.info.threadId, editorId },
        '[acp-threads] harness MCP-config probe failed — injecting OK MCP',
      );
      return null;
    }
    if (hit !== null) {
      this.opts.log.info(
        {
          threadId: record.info.threadId,
          agentId: record.agentRef.id,
          editorId: hit.editorId,
          scope: hit.scope,
          configPath: hit.configPath,
        },
        "[acp-threads] skipping OK MCP injection — the agent's harness already loads OK's managed entry",
      );
    }
    return hit;
  }

  private async settlePiBridge(
    record: ThreadRecord,
    consentBudgetMs: number,
  ): Promise<PiBridgeOutcome> {
    const probe = this.opts.probePiAcpBridge;
    const threadId = record.info.threadId;
    if (probe === undefined) {
      this.opts.log.debug(
        { threadId, agentId: record.agentRef.id },
        '[acp-threads] no Pi bridge probe wired — OK tools depend on whether the project was already wired',
      );
      return 'unknown';
    }
    let state: PiAcpBridgeProbe;
    try {
      state = await probe(record.cwd);
    } catch (err) {
      this.opts.log.warn({ err, threadId }, '[acp-threads] Pi bridge probe failed');
      return 'unknown';
    }
    if (record.closed) return 'unknown';
    if (state.bridgeLoadable) {
      this.opts.log.info(
        { threadId, bridge: state.bridge, bridgePath: state.bridgePath },
        '[acp-threads] Pi already loads the OK bridge extension for this project',
      );
      return 'loadable';
    }
    if (state.bridge === 'foreign' || state.bridge === 'unreadable') {
      this.opts.log.warn(
        { threadId, bridge: state.bridge, bridgePath: state.bridgePath },
        "[acp-threads] OK can't claim the Pi bridge path — leaving it alone; this thread has no OK tools",
      );
      this.emitPiBridgeStatus(record, {
        kind: 'pi_bridge_status',
        state: state.bridge === 'foreign' ? 'foreign-file' : 'unreadable-file',
        bridgePath: state.bridgePath,
        ts: Date.now(),
      });
      return 'unavailable';
    }
    if (record.piBridgeDeclined) {
      this.opts.log.debug(
        { threadId },
        '[acp-threads] Pi bridge prompt already declined for this thread — not re-asking',
      );
      return 'unavailable';
    }
    const ensure = this.opts.ensurePiAcpBridge;
    if (ensure === undefined) {
      this.opts.log.warn(
        { threadId },
        '[acp-threads] Pi bridge is not provisioned and no provisioning seam is wired — not prompting',
      );
      return 'unavailable';
    }

    const requestId = crypto.randomUUID();
    const decision = await this.requestPiBridgeConsent(record, requestId, state, consentBudgetMs);
    if (decision === 'declined') record.piBridgeDeclined = true;
    if (record.closed) return 'unknown';
    if (decision !== 'granted') {
      this.opts.log.info(
        { threadId, decision },
        '[acp-threads] Pi bridge not provisioned — the thread continues without OK tools',
      );
      return 'unavailable';
    }

    let result: PiAcpBridgeEnsureResult;
    try {
      result = await ensure(record.cwd);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.opts.log.warn({ err, threadId }, '[acp-threads] Pi bridge provisioning threw');
      this.appendPiBridgeFailure(record, requestId, 'bridge-failed', state.bridgePath, { detail });
      return 'unavailable';
    }
    if (result.ok) {
      this.opts.log.info(
        { threadId, bridge: result.bridge, trust: result.trust, bridgePath: result.bridgePath },
        '[acp-threads] provisioned the Pi bridge extension for this project',
      );
      if (record.closed) return 'unknown';
      this.appendEvent(record, {
        kind: 'pi_bridge_status',
        requestId,
        state: 'ready',
        bridgePath: result.bridgePath,
        bridge: result.bridge,
        trust: result.trust,
        ts: Date.now(),
      });
      return 'loadable';
    }
    const bridgeLanded =
      result.bridge === 'written' || result.bridge === 'refreshed' || result.bridge === 'unchanged';
    const state2: PiBridgeThreadState =
      result.bridge === 'refused-foreign'
        ? 'foreign-file'
        : result.bridge === 'refused-unreadable'
          ? 'unreadable-file'
          : bridgeLanded
            ? 'trust-failed'
            : 'bridge-failed';
    this.opts.log.warn(
      {
        threadId,
        bridge: result.bridge,
        trust: result.trust,
        bridgePath: result.bridgePath,
        err: result.error,
      },
      '[acp-threads] Pi bridge provisioning did not complete — the thread continues without OK tools',
    );
    this.appendPiBridgeFailure(record, requestId, state2, result.bridgePath, {
      bridge: result.bridge,
      trust: result.trust,
      ...(result.error !== undefined ? { detail: result.error } : {}),
    });
    return 'unavailable';
  }

  private appendPiBridgeFailure(
    record: ThreadRecord,
    requestId: string,
    state: PiBridgeThreadState,
    bridgePath: string,
    extra: { bridge?: PiBridgeWriteAction; trust?: PiTrustWriteAction; detail?: string },
  ): void {
    if (record.closed) return;
    this.appendEvent(record, {
      kind: 'pi_bridge_status',
      requestId,
      state,
      bridgePath,
      ...extra,
      ts: Date.now(),
    });
  }

  private emitPiBridgeStatus(
    record: ThreadRecord,
    event: Extract<ThreadEvent, { kind: 'pi_bridge_status' }>,
  ): void {
    if (record.lastPiBridgeStatus === event.state) return;
    record.lastPiBridgeStatus = event.state;
    this.appendEvent(record, event);
  }

  private requestPiBridgeConsent(
    record: ThreadRecord,
    requestId: string,
    state: PiAcpBridgeProbe,
    budgetMs: number,
  ): Promise<'granted' | 'declined' | 'timeout' | 'closed'> {
    this.appendEvent(record, {
      kind: 'pi_bridge_consent_request',
      requestId,
      agentName: record.info.agent.name,
      bridgePath: state.bridgePath,
      cwd: record.cwd,
      otherExtensions: state.otherExtensions,
      ts: Date.now(),
    });
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        record.pendingPiBridgeConsent.delete(requestId);
        this.appendEvent(record, {
          kind: 'pi_bridge_consent_resolved',
          requestId,
          decision: 'timeout',
          ts: Date.now(),
        });
        resolvePromise('timeout');
      }, budgetMs);
      timer.unref?.();
      record.pendingPiBridgeConsent.set(requestId, { resolve: resolvePromise, timer });
    });
  }

  respondPiBridgeConsent(
    threadId: string,
    requestId: string,
    outcome: { kind: 'granted' } | { kind: 'declined' },
  ): void {
    const t = this.mustGet(threadId);
    const pending = t.pendingPiBridgeConsent.get(requestId);
    if (pending === undefined) return;
    t.pendingPiBridgeConsent.delete(requestId);
    clearTimeout(pending.timer);
    const decision = outcome.kind === 'granted' ? 'granted' : 'declined';
    this.appendEvent(t, {
      kind: 'pi_bridge_consent_resolved',
      requestId,
      decision,
      ts: Date.now(),
    });
    pending.resolve(decision);
  }

  private async startThread(
    record: ThreadRecord,
    params: {
      agent: { source: 'registry' | 'custom'; id: string };
      prompt?: string;
      attachments?: readonly AttachmentPart[];
      settings?: { config?: Record<string, string | boolean>; modeId?: string };
    },
    custom: CustomAgentEntry | null,
    consentBudgetMs: number = CONSENT_TIMEOUT_MS,
  ): Promise<void> {
    let handshake: Awaited<ReturnType<AcpThreadManager['connectAgent']>>;
    try {
      handshake = await this.connectAgent(record, custom);
    } catch (err) {
      const detail =
        err instanceof AgentLaunchError || err instanceof ThreadOpError ? err.message : String(err);
      this.emitStatus(record, 'error', detail, {
        reason: 'connect',
        agentMessage: detail,
        machineDetail: stderrTailDetail(record),
      });
      await this.teardownFailedAgent(record);
      return;
    }
    if (handshake === null) return;
    const { conn, init, launch } = handshake;

    if (
      (await this.openSession(record, conn, init, params.settings, 'park', consentBudgetMs)) !==
      true
    ) {
      return;
    }
    this.opts.log.info(
      {
        threadId: record.info.threadId,
        agentId: record.info.agent.id,
        launchKind: launch.kind,
        msToReady: Date.now() - record.info.createdAt,
      },
      '[acp-threads] agent ready',
    );

    const hasContent =
      (params.prompt !== undefined && params.prompt !== '') ||
      (params.attachments !== undefined && params.attachments.length > 0);
    if (hasContent) {
      this.sendPrompt(record.info.threadId, params.prompt ?? '', params.attachments);
    }
  }

  private async openSession(
    record: ThreadRecord,
    conn: ClientConnection,
    init: InitializeResponse,
    settings?: { config?: Record<string, string | boolean>; modeId?: string },
    onAuthRequired: 'park' | 'report' = 'park',
    consentBudgetMs: number = CONSENT_TIMEOUT_MS,
  ): Promise<boolean | 'auth-required'> {
    record.info.availableCommands = null;
    const { servers: mcpServers } = await this.buildMcpServers(record, init, consentBudgetMs);
    try {
      const session = await conn.agent.request(acpMethods.agent.session.new, {
        cwd: record.cwd,
        mcpServers,
      });
      record.sessionId = session.sessionId;
      record.envNotePending = true;
      this.persistence.queueMetaWrite(record.info.threadId, this.buildMeta(record));
      if (session.modes !== undefined && session.modes !== null) {
        record.info.modes = session.modes;
        this.emitInfo(record);
      }
      if (session.configOptions !== undefined && session.configOptions !== null) {
        record.info.configOptions = session.configOptions;
        this.emitInfo(record);
      }
    } catch (err) {
      if (isAuthRequiredError(err)) {
        if (onAuthRequired === 'report') return 'auth-required';
        this.emitStatus(record, 'auth_required', `sign in required: ${agentErrorMessage(err)}`, {
          reason: 'auth-required',
          agentMessage: agentErrorMessage(err),
          machineDetail: authMachineDetail(err, record),
          authMethods: threadAuthMethods(init.authMethods),
        });
      } else {
        this.emitStatus(record, 'error', `session setup failed: ${agentErrorMessage(err)}`, {
          reason: 'session-setup',
          agentMessage: agentErrorMessage(err),
          machineDetail: joinMachineDetail(agentErrorData(err), stderrTailDetail(record)),
        });
        await this.teardownFailedAgent(record);
      }
      return false;
    }
    if (record.closed) return false;

    if (settings?.config !== undefined) {
      await this.applyInitialConfig(record, conn, settings.config);
      if (record.closed) return false;
    }
    if (settings?.modeId !== undefined) {
      await this.applyInitialMode(record, conn, settings.modeId);
      if (record.closed) return false;
    }

    this.emitStatus(record, 'ready');
    return true;
  }

  async resumeThread(
    threadId: string,
    prompt?: string,
    attachments?: readonly AttachmentPart[],
  ): Promise<ThreadInfo> {
    if (this.destroyed) throw new ThreadOpError('capacity', 'server is shutting down');
    const t = this.mustGet(threadId);
    if (t.info.archived !== true) {
      throw new ThreadOpError('not-ready', 'thread is not archived');
    }
    if (t.resumeInFlight) {
      throw new ThreadOpError('not-ready', 'a resume is already in progress');
    }
    if (this.liveThreadCount() >= this.maxThreads) {
      throw new ThreadOpError('capacity', `maximum of ${this.maxThreads} concurrent agent threads`);
    }
    t.resumeInFlight = true;
    const startedAt = Date.now();
    try {
      await this.ensureLogResolved(t);
      const sessionId = t.sessionId;
      const { info: agentInfo, custom } = await this.resolveAgentInfo(t.agentRef);
      if (this.destroyed) throw new ThreadOpError('capacity', 'server is shutting down');
      if (this.liveThreadCount() >= this.maxThreads) {
        throw new ThreadOpError(
          'capacity',
          `maximum of ${this.maxThreads} concurrent agent threads`,
        );
      }
      t.info.agent = agentInfo;
      t.info.archived = false;
      t.info.availableCommands = null;
      t.stderrTail = [];
      if (t.midTurnOnDisk) {
        t.midTurnOnDisk = false;
        this.appendEvent(t, { kind: 'turn_ended', stopReason: 'cancelled', ts: Date.now() });
      }
      const hasContent =
        (prompt !== undefined && prompt !== '') ||
        (attachments !== undefined && attachments.length > 0);
      if (hasContent) {
        this.echoUserMessage(t, prompt ?? '', attachments);
        this.flushBroadcast(t);
      }
      this.emitStatus(t, 'installing');
      try {
        if (sessionId === null) {
          throw new ThreadOpError(
            'resume-unsupported',
            'this thread never completed an agent session',
          );
        }
        const handshake = await this.connectAgent(t, custom);
        if (handshake === null) {
          throw new ThreadOpError('not-ready', 'thread closed during resume');
        }
        const { conn, init } = handshake;
        const { servers: mcpServers } = await this.buildMcpServers(
          t,
          init,
          BLOCKING_CONSENT_TIMEOUT_MS,
        );
        const caps = init.agentCapabilities;
        const viaResume = caps?.sessionCapabilities?.resume != null;
        let response: { modes?: unknown; configOptions?: unknown };
        if (viaResume) {
          response = await conn.agent.request(acpMethods.agent.session.resume, {
            sessionId,
            cwd: t.cwd,
            mcpServers,
          });
        } else if (caps?.loadSession === true) {
          t.suppressUpdates = true;
          t.lastSuppressedAt = Date.now();
          try {
            response = await conn.agent.request(acpMethods.agent.session.load, {
              sessionId,
              cwd: t.cwd,
              mcpServers,
            });
            await this.awaitReplayQuiescence(t);
          } finally {
            t.suppressUpdates = false;
          }
        } else {
          throw new ThreadOpError(
            'resume-unsupported',
            `${t.info.agent.name} doesn't support resuming previous sessions`,
          );
        }
        t.sessionId = sessionId;
        const resumedConfig: Record<string, string | boolean> = Object.fromEntries(
          (t.info.configOptions ?? []).map((option) => [option.id, option.currentValue]),
        );
        const resumedModeId = t.info.modes?.currentModeId;
        const modes = response.modes as ThreadInfo['modes'] | undefined;
        if (modes !== undefined && modes !== null) t.info.modes = modes;
        const configOptions = response.configOptions as ThreadInfo['configOptions'] | undefined;
        if (configOptions !== undefined && configOptions !== null) {
          t.info.configOptions = configOptions;
        }
        await this.applyInitialConfig(t, conn, resumedConfig, configOptions == null);
        if (t.closed) throw new ThreadOpError('not-ready', 'thread closed during resume');
        if (resumedModeId !== undefined) {
          await this.applyInitialMode(t, conn, resumedModeId, modes == null);
          if (t.closed) throw new ThreadOpError('not-ready', 'thread closed during resume');
        }
        this.emitStatus(t, 'ready');
        this.opts.log.info(
          {
            threadId,
            agentId: t.info.agent.id,
            method: viaResume ? 'session/resume' : 'session/load',
            msToResumed: Date.now() - startedAt,
          },
          '[acp-threads] thread resumed',
        );
        if (hasContent) {
          this.dispatchPrompt(t, prompt ?? '', attachments, { echo: false });
        }
        return { ...t.info };
      } catch (err) {
        await this.abortResume(t);
        if (err instanceof ThreadOpError) throw err;
        if (err instanceof AgentLaunchError) {
          throw new ThreadOpError(
            err.code === 'install-failed' ? 'install-failed' : 'spawn-failed',
            err.message,
          );
        }
        this.opts.log.warn({ err, threadId }, '[acp-threads] resume rejected by the agent');
        throw new ThreadOpError(
          'resume-unsupported',
          `couldn't resume the previous session: ${agentErrorMessage(err)}`,
        );
      }
    } finally {
      t.resumeInFlight = false;
    }
  }

  async retryThread(threadId: string): Promise<ThreadInfo> {
    if (this.destroyed) throw new ThreadOpError('capacity', 'server is shutting down');
    const t = this.mustGet(threadId);
    if (t.info.archived === true) {
      throw new ThreadOpError('not-ready', 'the thread is archived — resume it instead');
    }
    if (t.info.status !== 'error' && t.info.status !== 'auth_required' && !t.authInFlight) {
      throw new ThreadOpError('not-ready', 'this thread did not fail to start');
    }
    if (t.sessionId !== null) {
      throw new ThreadOpError('not-ready', 'this thread already has an agent session');
    }
    if (t.resumeInFlight) {
      throw new ThreadOpError('not-ready', 'a retry is already in progress');
    }
    t.resumeInFlight = true;
    try {
      resetSharedLoginShellPathProvider();
      this.healthyInterpreters.clear();
      const { info: agentInfo, custom } = await this.resolveAgentInfo(t.agentRef);
      await this.teardownFailedAgent(t);
      t.info.agent = agentInfo;
      t.stderrTail = [];
      t.cancelRequested = false;
      t.turnActive = false;
      this.emitStatus(t, 'installing');
      try {
        await this.startThread(
          t,
          { agent: t.agentRef, settings: t.launchSettings },
          custom,
          BLOCKING_CONSENT_TIMEOUT_MS,
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        this.emitStatus(t, 'error', detail, { reason: 'connect', agentMessage: detail });
        throw new ThreadOpError('spawn-failed', detail);
      }
      if (t.closed) throw new ThreadOpError('not-ready', 'thread closed during retry');
      const settled = this.getInfo(threadId)?.status;
      if (settled === 'ready' || settled === 'running') {
        this.opts.log.info(
          { threadId, agentId: t.info.agent.id },
          '[acp-threads] thread retry succeeded',
        );
        return { ...t.info };
      }
      throw new ThreadOpError('spawn-failed', lastFailureMessage(t) ?? 'the agent failed to start');
    } finally {
      t.resumeInFlight = false;
    }
  }

  async authenticateThread(threadId: string, methodId: string): Promise<ThreadInfo> {
    if (this.destroyed) throw new ThreadOpError('capacity', 'server is shutting down');
    const t = this.mustGet(threadId);
    if (t.info.archived === true) {
      throw new ThreadOpError('not-ready', 'the thread is archived — resume it instead');
    }
    if (t.info.status !== 'auth_required') {
      throw new ThreadOpError('not-ready', 'this thread is not waiting for a sign-in');
    }
    const conn = t.conn;
    const init = t.lastInit;
    if (conn === null || init === null || t.child === null) {
      throw new ThreadOpError(
        'not-ready',
        `${t.info.agent.name} is no longer running — use Retry to start it again`,
      );
    }
    if (t.resumeInFlight) {
      throw new ThreadOpError('not-ready', 'the thread is starting over — wait for the retry');
    }
    if (t.authInFlight) {
      throw new ThreadOpError('not-ready', 'a sign-in is already in progress');
    }
    t.authInFlight = true;
    t.authStderr = [];
    t.info.signInOutput = undefined;
    try {
      this.emitStatus(t, 'authenticating');
      try {
        await this.requestAuthenticate(conn, methodId);
      } catch (err) {
        if (t.conn !== conn) throw threadRestartedDuringSignIn();
        const timedOut = err instanceof AuthenticateTimeoutError;
        const message = timedOut
          ? `the sign-in didn't complete in time — try again`
          : agentErrorMessage(err);
        this.emitStatus(t, 'auth_required', `sign-in failed: ${message}`, {
          reason: 'auth-required',
          agentMessage: message,
          machineDetail: authMachineDetail(err, t),
          authMethods: threadAuthMethods(init.authMethods),
        });
        throw new ThreadOpError('not-ready', message);
      }
      if (t.closed) throw new ThreadOpError('not-ready', 'thread closed during sign-in');
      if (t.conn !== conn) throw threadRestartedDuringSignIn();
      const opened = await this.openSession(
        t,
        conn,
        init,
        t.launchSettings,
        'report',
        BLOCKING_CONSENT_TIMEOUT_MS,
      );
      if (opened === 'auth-required') {
        this.opts.log.info(
          { threadId, agentId: t.info.agent.id, methodId },
          '[acp-threads] signed in but session still refused — relaunching the agent',
        );
        this.closeSignInCapture(t);
        try {
          return await this.retryThread(threadId);
        } catch (err) {
          if (this.getInfo(threadId)?.status === 'authenticating') {
            this.emitStatus(t, 'auth_required', `sign in required: ${agentErrorMessage(err)}`, {
              reason: 'auth-required',
              agentMessage: agentErrorMessage(err),
              machineDetail: authMachineDetail(err, t),
              authMethods: threadAuthMethods(init.authMethods),
            });
          }
          throw err;
        }
      }
      if (opened !== true) {
        throw new ThreadOpError(
          'not-ready',
          lastFailureMessage(t) ?? `${t.info.agent.name} still couldn't start a conversation`,
        );
      }
      this.opts.log.info(
        { threadId, agentId: t.info.agent.id, methodId },
        '[acp-threads] thread signed in',
      );
      return { ...t.info };
    } finally {
      t.authInFlight = false;
      this.closeSignInCapture(t);
    }
  }

  private async requestAuthenticate(conn: ClientConnection, methodId: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new AuthenticateTimeoutError()), this.authenticateTimeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.race([conn.agent.request(acpMethods.agent.authenticate, { methodId }), expiry]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async abortResume(t: ThreadRecord): Promise<void> {
    t.closed = true;
    t.suppressUpdates = false;
    this.failPendingPermissions(t);
    this.failPendingConsents(t);
    try {
      t.conn?.close();
    } catch {}
    const child = t.child;
    if (child !== null) {
      await terminateAgentTree(child, { graceMs: DESTROY_KILL_GRACE_MS });
    }
    t.child = null;
    t.conn = null;
    t.lastInit = null;
    t.closed = false;
    t.turnActive = false;
    this.opts.agentPresenceBroadcaster?.clearPresence(toBroadcasterKey(t.agentSessionId));
    t.info.archived = true;
    this.emitStatus(t, 'exited', 'resume failed');
    this.flushBroadcast(t);
    this.persistence.queueMetaWrite(t.info.threadId, this.buildMeta(t));
    await this.persistence.whenIdle(t.info.threadId);
    t.baseSeq = t.info.lastSeq + 1;
    t.events = [];
  }

  private async awaitReplayQuiescence(t: ThreadRecord): Promise<void> {
    const deadline = Date.now() + RESUME_REPLAY_MAX_WAIT_MS;
    while (Date.now() - t.lastSuppressedAt < RESUME_REPLAY_QUIESCENCE_MS && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  sendPrompt(threadId: string, content: string, attachments?: readonly AttachmentPart[]): void {
    const t = this.mustGet(threadId);
    if (t.info.archived === true) {
      throw new ThreadOpError('not-ready', 'the thread is archived — resume it first');
    }
    if (t.resumeInFlight) {
      throw new ThreadOpError('not-ready', 'the thread is still resuming');
    }
    if (t.authInFlight) {
      throw new ThreadOpError('not-ready', 'the thread is still signing in');
    }
    if (t.sessionId === null || t.conn === null) {
      throw new ThreadOpError('not-ready', 'thread has no live agent session');
    }
    if (t.turnActive) {
      const queue = t.info.queue ?? [];
      if (queue.length >= MAX_QUEUED_PROMPTS) {
        throw new ThreadOpError(
          'not-ready',
          `${MAX_QUEUED_PROMPTS} messages are already waiting — let the agent catch up`,
        );
      }
      const entry: QueuedMessage = { id: crypto.randomUUID(), content, ts: Date.now() };
      if (attachments !== undefined && attachments.length > 0) entry.attachments = attachments;
      t.info.queue = [...queue, entry];
      t.info.lastActivityAt = Date.now();
      this.emitInfo(t);
      return;
    }
    this.dispatchPrompt(t, content, attachments, { echo: true });
  }

  steerPrompt(threadId: string, content: string, attachments?: readonly AttachmentPart[]): void {
    const t = this.mustGet(threadId);
    if (t.info.archived === true) {
      throw new ThreadOpError('not-ready', 'the thread is archived — resume it first');
    }
    if (t.resumeInFlight) {
      throw new ThreadOpError('not-ready', 'the thread is still resuming');
    }
    if (t.authInFlight) {
      throw new ThreadOpError('not-ready', 'the thread is still signing in');
    }
    if (t.sessionId === null || t.conn === null) {
      throw new ThreadOpError('not-ready', 'thread has no live agent session');
    }
    if (!t.turnActive) {
      this.dispatchPrompt(t, content, attachments, { echo: true });
      return;
    }
    this.clearSteer(t);
    const steer: SteerMessage = { content, ts: Date.now() };
    if (attachments !== undefined && attachments.length > 0) steer.attachments = attachments;
    t.info.steer = steer;
    t.info.lastActivityAt = Date.now();
    this.emitInfo(t);
    const timer = setTimeout(() => this.demoteStalledSteer(t), this.steerStallMs);
    timer.unref?.();
    t.steerStallTimer = timer;
    this.cancelTurn(t, { clearQueue: false });
  }

  private demoteStalledSteer(t: ThreadRecord): void {
    t.steerStallTimer = null;
    const steer = t.info.steer;
    if (steer === undefined || t.closed || !t.turnActive) return;
    t.info.steer = undefined;
    const demoted: QueuedMessage = {
      id: crypto.randomUUID(),
      content: steer.content,
      ts: steer.ts,
    };
    if (steer.attachments !== undefined && steer.attachments.length > 0) {
      demoted.attachments = steer.attachments;
    }
    t.info.queue = [demoted, ...(t.info.queue ?? [])];
    this.emitInfo(t);
  }

  private clearSteer(t: ThreadRecord): void {
    if (t.steerStallTimer !== null) {
      clearTimeout(t.steerStallTimer);
      t.steerStallTimer = null;
    }
    t.info.steer = undefined;
  }

  private takeSteer(t: ThreadRecord): SteerMessage | null {
    const steer = t.info.steer;
    if (steer === undefined) return null;
    this.clearSteer(t);
    return steer;
  }

  editQueued(threadId: string, id: string, content: string): boolean {
    const t = this.mustGet(threadId);
    const queue = t.info.queue ?? [];
    if (!queue.some((m) => m.id === id)) return false;
    t.info.queue = queue.map((m) => (m.id === id ? { ...m, content, held: false } : m));
    this.emitInfo(t);
    this.drainIfIdle(t);
    return true;
  }

  holdQueued(threadId: string, id: string, held: boolean): boolean {
    const t = this.mustGet(threadId);
    const queue = t.info.queue ?? [];
    if (!queue.some((m) => m.id === id)) return false;
    t.info.queue = queue.map((m) => (m.id === id ? { ...m, held } : m));
    this.emitInfo(t);
    if (!held) this.drainIfIdle(t);
    return true;
  }

  removeQueued(threadId: string, id: string): boolean {
    const t = this.mustGet(threadId);
    const queue = t.info.queue ?? [];
    const next = queue.filter((m) => m.id !== id);
    if (next.length === queue.length) return false;
    t.info.queue = next.length > 0 ? next : undefined;
    this.emitInfo(t);
    return true;
  }

  private drainIfIdle(t: ThreadRecord): void {
    if (t.turnActive || t.closed || t.resumeInFlight) return;
    if (t.info.archived === true || t.sessionId === null || t.conn === null) return;
    const next = this.takeNextQueued(t);
    if (next === null) return;
    this.dispatchPrompt(t, next.content, next.attachments, { echo: true });
  }

  private takeNextQueued(t: ThreadRecord): QueuedMessage | null {
    const queue = t.info.queue;
    if (queue === undefined || queue.length === 0) return null;
    const index = queue.findIndex((m) => m.held !== true);
    if (index === -1) return null;
    const next = queue[index];
    const rest = [...queue.slice(0, index), ...queue.slice(index + 1)];
    t.info.queue = rest.length > 0 ? rest : undefined;
    return next ?? null;
  }

  private echoUserMessage(
    t: ThreadRecord,
    content: string,
    attachments?: readonly AttachmentPart[],
  ): void {
    t.hadUserMessage = true;
    if (t.info.title === t.info.agent.name && content.trim() !== '') {
      const source = t.titleHint !== undefined && t.titleHint.trim() !== '' ? t.titleHint : content;
      t.titleHint = undefined;
      t.info.title = deriveThreadTitle(source, t.info.agent.name);
      this.appendEvent(t, { kind: 'title_changed', title: t.info.title, ts: Date.now() });
      this.emitInfo(t);
    }
    const event: ThreadEvent = { kind: 'user_message', content, ts: Date.now() };
    if (attachments !== undefined && attachments.length > 0) event.attachments = attachments;
    this.appendEvent(t, event);
  }

  async renameThread(threadId: string, rawTitle: string): Promise<void> {
    const t = this.mustGet(threadId);
    if (t.closed) {
      throw new ThreadOpError('not-ready', 'the thread is closing');
    }
    const title = clampThreadTitle(rawTitle);
    if (title === '' || title === t.info.title) return;
    await this.ensureLogResolved(t);
    t.info.title = title;
    t.info.lastActivityAt = Date.now();
    this.appendEvent(t, { kind: 'title_changed', title, ts: Date.now() });
    this.flushBroadcast(t);
    this.emitInfo(t);
    await this.persistence.whenIdle(t.info.threadId);
  }

  private dispatchPrompt(
    t: ThreadRecord,
    content: string,
    attachments: readonly AttachmentPart[] | undefined,
    opts: { echo: boolean },
  ): void {
    if (t.sessionId === null || t.conn === null) {
      throw new ThreadOpError('not-ready', 'thread has no live agent session');
    }
    if (opts.echo) {
      this.echoUserMessage(t, content, attachments);
    }
    let wireText = content;
    if (t.envNotePending && !content.startsWith('/')) {
      t.envNotePending = false;
      wireText = `${ACP_ENVIRONMENT_NOTE}\n\n${content}`;
    }
    t.turnActive = true;
    t.cancelRequested = false;
    this.appendEvent(t, { kind: 'turn_started', ts: Date.now() });
    this.emitStatus(t, 'running');

    const sessionId = t.sessionId;
    const promptBuild = buildPromptBlocks(
      wireText,
      attachments,
      t.info.promptCapabilities,
      (requested) => this.confinePath(requested).then(({ abs, rel }) => ({ abs, rel })),
    );
    const requestPromise = promptBuild.then((built) => {
      if (built.dropped.length > 0) {
        this.opts.log.warn(
          {
            threadId: t.info.threadId,
            dropped: built.dropped.map((d) => ({ kind: d.part.kind, reason: d.reason })),
          },
          '[acp-threads] dropped attachment parts before session/prompt',
        );
        const dropTs = Date.now();
        for (const d of built.dropped) {
          const label =
            d.part.kind === 'image' || d.part.kind === 'blob'
              ? d.part.name
              : d.part.name || d.part.path;
          this.appendEvent(t, {
            kind: 'agent_stderr',
            line: `[attachment dropped] ${label}: ${d.reason}`,
            ts: dropTs,
          });
        }
      }
      if (t.sessionId === null || t.conn === null) {
        throw new ThreadOpError('not-ready', 'thread has no live agent session');
      }
      if (t.cancelRequested) {
        throw new PromptCancelledBeforeDispatchError();
      }
      return t.conn.agent.request(acpMethods.agent.session.prompt, {
        sessionId,
        prompt: [...built.blocks],
      });
    });
    requestPromise
      .then((response) => {
        t.turnActive = false;
        if (t.closed) return;
        this.appendEvent(t, {
          kind: 'turn_ended',
          stopReason: response.stopReason,
          ts: Date.now(),
        });
        if (t.sessionId !== null && t.conn !== null) {
          const steer = this.takeSteer(t);
          if (steer !== null) {
            this.dispatchPrompt(t, steer.content, steer.attachments, { echo: true });
            return;
          }
          const next = this.takeNextQueued(t);
          if (next !== null) {
            this.dispatchPrompt(t, next.content, next.attachments, { echo: true });
            return;
          }
        }
        this.emitStatus(t, 'ready');
      })
      .catch((err) => {
        t.turnActive = false;
        if (t.closed) return;
        this.appendEvent(t, { kind: 'turn_ended', stopReason: 'cancelled', ts: Date.now() });
        if (t.sessionId !== null && t.conn !== null) {
          const steer = this.takeSteer(t);
          if (steer !== null) {
            this.dispatchPrompt(t, steer.content, steer.attachments, { echo: true });
            return;
          }
        }
        if (t.cancelRequested) {
          this.emitStatus(t, 'ready');
          this.drainIfIdle(t);
          return;
        }
        if (isAuthRequiredError(err)) {
          this.emitStatus(t, 'auth_required', `sign in required: ${agentErrorMessage(err)}`, {
            reason: 'auth-required',
            agentMessage: agentErrorMessage(err),
            machineDetail: authMachineDetail(err, t),
            authMethods: threadAuthMethods(t.lastInit?.authMethods),
          });
          return;
        }
        this.emitStatus(t, 'error', `prompt failed: ${agentErrorMessage(err)}`, {
          reason: 'prompt',
          agentMessage: agentErrorMessage(err),
          machineDetail: joinMachineDetail(agentErrorData(err), stderrTailDetail(t)),
        });
      });
  }

  cancel(threadId: string): void {
    this.cancelTurn(this.mustGet(threadId), { clearQueue: true });
  }

  private cancelTurn(t: ThreadRecord, opts: { clearQueue: boolean }): void {
    if (opts.clearQueue && (t.info.queue !== undefined || t.info.steer !== undefined)) {
      t.info.queue = undefined;
      this.clearSteer(t);
      this.emitInfo(t);
    }
    if (t.conn === null || t.sessionId === null) return;
    if (t.turnActive) t.cancelRequested = true;
    this.failPendingPermissions(t);
    this.restoreRunningAfterPermission(t);
    t.conn.agent
      .notify(acpMethods.agent.session.cancel, { sessionId: t.sessionId })
      .catch((err: unknown) => {
        this.opts.log.debug(
          { err, threadId: t.info.threadId },
          '[acp-threads] cancel notification never reached the agent',
        );
      });
  }

  setMode(threadId: string, modeId: string): void {
    const t = this.mustGet(threadId);
    if (t.info.archived === true) {
      const modes = t.info.modes;
      if (modes == null || !modes.availableModes.some((m) => m.id === modeId)) {
        throw new ThreadOpError('not-ready', `no such mode: ${modeId}`);
      }
      t.info.modes = { ...modes, currentModeId: modeId };
      this.emitInfo(t);
      return;
    }
    if (t.resumeInFlight) {
      throw new ThreadOpError('not-ready', 'the thread is still resuming');
    }
    if (t.conn === null || t.sessionId === null) {
      throw new ThreadOpError('not-ready', 'thread has no live agent session');
    }
    void t.conn.agent
      .request(acpMethods.agent.session.setMode, { sessionId: t.sessionId, modeId })
      .then(() => {
        if (t.info.modes) {
          t.info.modes = { ...t.info.modes, currentModeId: modeId };
          this.emitInfo(t);
        }
      })
      .catch((err) => {
        this.opts.log.warn({ err, threadId }, '[acp-threads] set_mode failed');
      });
  }

  setConfigOption(threadId: string, configId: string, value: string | boolean): void {
    const t = this.mustGet(threadId);
    if (t.info.archived === true) {
      const option = (t.info.configOptions ?? []).find((o) => o.id === configId);
      if (option === undefined) {
        throw new ThreadOpError('not-ready', `no such config option: ${configId}`);
      }
      if (!initialConfigValueValid(option, value)) {
        throw new ThreadOpError('not-ready', `invalid value for ${configId}`);
      }
      t.info.configOptions = (t.info.configOptions ?? []).map((o) =>
        o.id === configId ? ({ ...o, currentValue: value } as SessionConfigOption) : o,
      );
      this.emitInfo(t);
      return;
    }
    if (t.resumeInFlight) {
      throw new ThreadOpError('not-ready', 'the thread is still resuming');
    }
    if (t.conn === null || t.sessionId === null) {
      throw new ThreadOpError('not-ready', 'thread has no live agent session');
    }
    const request: SetSessionConfigOptionRequest =
      typeof value === 'boolean'
        ? { sessionId: t.sessionId, configId, type: 'boolean', value }
        : { sessionId: t.sessionId, configId, value };
    void t.conn.agent
      .request(acpMethods.agent.session.setConfigOption, request)
      .then((response: SetSessionConfigOptionResponse) => {
        t.info.configOptions = response.configOptions;
        this.emitInfo(t);
      })
      .catch((err) => {
        this.opts.log.warn({ err, threadId, configId }, '[acp-threads] set_config_option failed');
      });
  }

  private async applyInitialConfig(
    record: ThreadRecord,
    conn: NonNullable<ThreadRecord['conn']>,
    config: Record<string, string | boolean>,
    sessionStateUnknown = false,
  ): Promise<void> {
    const sessionId = record.sessionId;
    if (sessionId === null) return;
    const isModel = (id: string): boolean =>
      (record.info.configOptions ?? []).find((o) => o.id === id)?.category === 'model';
    const ids = Object.keys(config).sort((a, b) => Number(isModel(b)) - Number(isModel(a)));
    let applied = false;
    const rejected: string[] = [];
    for (const configId of ids) {
      const value = config[configId];
      if (value === undefined) continue;
      const option = (record.info.configOptions ?? []).find((o) => o.id === configId);
      if (option === undefined) continue;
      if (!sessionStateUnknown && option.currentValue === value) continue;
      if (!initialConfigValueValid(option, value)) continue;
      const request: SetSessionConfigOptionRequest =
        typeof value === 'boolean'
          ? { sessionId, configId, type: 'boolean', value }
          : { sessionId, configId, value };
      try {
        const response: SetSessionConfigOptionResponse = await conn.agent.request(
          acpMethods.agent.session.setConfigOption,
          request,
        );
        record.info.configOptions = response.configOptions;
        applied = true;
      } catch (err) {
        rejected.push(configId);
        this.opts.log.warn(
          { err, threadId: record.info.threadId, configId },
          '[acp-threads] initial config apply failed',
        );
      }
      if (record.closed) return;
    }
    if (rejected.length > 0) {
      this.opts.log.warn(
        { threadId: record.info.threadId, rejectedConfigIds: rejected, sessionStateUnknown },
        '[acp-threads] some remembered config options could not be applied to the new session',
      );
    }
    if (applied) this.emitInfo(record);
  }

  private async applyInitialMode(
    record: ThreadRecord,
    conn: NonNullable<ThreadRecord['conn']>,
    modeId: string,
    sessionStateUnknown = false,
  ): Promise<void> {
    const sessionId = record.sessionId;
    if (sessionId === null) return;
    const modes = record.info.modes;
    if (modes != null) {
      if (modes.availableModes.some((m) => m.id === modeId)) {
        if (!sessionStateUnknown && modes.currentModeId === modeId) return;
        try {
          await conn.agent.request(acpMethods.agent.session.setMode, { sessionId, modeId });
          record.info.modes = { ...modes, currentModeId: modeId };
          this.emitInfo(record);
        } catch (err) {
          this.opts.log.warn(
            { err, threadId: record.info.threadId, modeId, method: 'set_mode' },
            '[acp-threads] initial mode apply failed',
          );
        }
        return;
      }
    }
    const option = (record.info.configOptions ?? []).find(
      (o) => o.category === 'mode' && initialConfigValueValid(o, modeId),
    );
    if (option === undefined) return;
    if (!sessionStateUnknown && option.currentValue === modeId) return;
    try {
      const response: SetSessionConfigOptionResponse = await conn.agent.request(
        acpMethods.agent.session.setConfigOption,
        { sessionId, configId: option.id, value: modeId },
      );
      record.info.configOptions = response.configOptions;
      this.emitInfo(record);
    } catch (err) {
      this.opts.log.warn(
        { err, threadId: record.info.threadId, modeId, method: 'set_config_option' },
        '[acp-threads] initial mode apply failed',
      );
    }
  }

  respondPermission(
    threadId: string,
    requestId: string,
    outcome: { kind: 'selected'; optionId: string } | { kind: 'cancelled' },
  ): void {
    const t = this.mustGet(threadId);
    const pending = t.pendingPermissions.get(requestId);
    if (pending === undefined) return;
    t.pendingPermissions.delete(requestId);
    clearTimeout(pending.timer);
    if (outcome.kind === 'selected') {
      pending.resolve({ outcome: { outcome: 'selected', optionId: outcome.optionId } });
      this.appendEvent(t, {
        kind: 'permission_resolved',
        requestId,
        optionId: outcome.optionId,
        auto: false,
        ts: Date.now(),
      });
    } else {
      pending.resolve({ outcome: { outcome: 'cancelled' } });
      this.appendEvent(t, {
        kind: 'permission_resolved',
        requestId,
        optionId: null,
        auto: false,
        ts: Date.now(),
      });
    }
    this.restoreRunningAfterPermission(t);
  }

  private restoreRunningAfterPermission(t: ThreadRecord): void {
    if (
      t.pendingPermissions.size === 0 &&
      t.turnActive &&
      t.info.status === 'awaiting_permission'
    ) {
      this.emitStatus(t, 'running');
    }
  }

  async closeThread(threadId: string, opts?: { killGraceMs?: number }): Promise<void> {
    const t = this.threads.get(threadId);
    if (t === undefined || t.info.archived === true || t.closed) return;
    t.closed = true;
    this.clearSteer(t);
    this.failPendingPermissions(t);
    this.failPendingConsents(t);
    try {
      t.conn?.close();
    } catch {}
    const child = t.child;
    if (child !== null) {
      const dead = await terminateAgentTree(child, {
        graceMs: opts?.killGraceMs ?? KILL_GRACE_MS,
      });
      if (!dead) {
        this.opts.log.error(
          { threadId, pid: child.pid },
          '[acp-threads] agent process survived SIGKILL escalation',
        );
      }
    }
    t.child = null;
    t.conn = null;
    t.lastInit = null;
    await t.terminals?.disposeAll();
    t.terminals = null;
    this.opts.agentPresenceBroadcaster?.clearPresence(toBroadcasterKey(t.agentSessionId));
    await this.opts.sessionManager.closeAllForAgent(t.agentSessionId).catch((err) => {
      this.opts.log.warn({ err, threadId }, '[acp-threads] session cleanup failed');
    });
    const failedStart = t.info.status === 'error' || t.info.status === 'auth_required';
    if (!t.hadUserMessage && !failedStart) {
      this.threads.delete(threadId);
      t.subscribers.clear();
      if (t.flushTimer !== null) {
        clearTimeout(t.flushTimer);
        t.flushTimer = null;
      }
      await this.persistence.whenIdle(threadId);
      await this.persistence.delete(threadId);
      this.opts.log.info({ threadId }, '[acp-threads] empty thread discarded on close');
      return;
    }
    if (t.turnActive) {
      t.turnActive = false;
      this.appendEvent(t, { kind: 'turn_ended', stopReason: 'cancelled', ts: Date.now() });
    }
    t.info.archived = true;
    this.emitStatus(t, 'exited', 'thread closed');
    this.flushBroadcast(t);
    this.persistence.queueMetaWrite(threadId, this.buildMeta(t));
    await this.persistence.whenIdle(threadId);
    t.baseSeq = t.info.lastSeq + 1;
    t.events = [];
    t.pendingBroadcast = [];
    t.closed = false;
    this.opts.log.info({ threadId }, '[acp-threads] thread archived');
  }

  async deleteThread(threadId: string): Promise<void> {
    const t = this.mustGet(threadId);
    if (t.info.archived !== true) {
      throw new ThreadOpError('not-ready', 'close the thread before deleting it');
    }
    if (t.resumeInFlight) {
      throw new ThreadOpError('not-ready', 'a resume is in progress');
    }
    this.threads.delete(threadId);
    t.subscribers.clear();
    if (t.flushTimer !== null) {
      clearTimeout(t.flushTimer);
      t.flushTimer = null;
    }
    await this.persistence.whenIdle(threadId);
    await this.persistence.delete(threadId);
    this.opts.log.info({ threadId }, '[acp-threads] thread deleted');
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    clearInterval(this.reapTimer);
    await Promise.allSettled(
      [...this.threads.keys()].map((id) =>
        this.closeThread(id, { killGraceMs: DESTROY_KILL_GRACE_MS }),
      ),
    );
  }

  private async handlePermissionRequest(
    record: ThreadRecord,
    toolCall: ToolCallUpdate,
    options: PermissionOption[],
  ): Promise<RequestPermissionResponse> {
    record.info.lastActivityAt = Date.now();
    const decision = this.opts.permissions.decide(record.info.agent.id, toolCall, options);
    if (decision.auto !== null) {
      const requestId = crypto.randomUUID();
      this.appendEvent(record, {
        kind: 'permission_resolved',
        requestId,
        optionId: decision.auto.optionId,
        auto: true,
        ts: Date.now(),
      });
      return { outcome: { outcome: 'selected', optionId: decision.auto.optionId } };
    }

    const requestId = crypto.randomUUID();
    this.appendEvent(record, {
      kind: 'permission_request',
      requestId,
      toolCall,
      options,
      ts: Date.now(),
    });
    if (record.turnActive && record.info.status === 'running') {
      this.emitStatus(record, 'awaiting_permission');
    }
    return new Promise<RequestPermissionResponse>((resolvePromise) => {
      const timer = setTimeout(() => {
        record.pendingPermissions.delete(requestId);
        this.appendEvent(record, {
          kind: 'permission_resolved',
          requestId,
          optionId: null,
          auto: true,
          ts: Date.now(),
        });
        this.restoreRunningAfterPermission(record);
        resolvePromise({ outcome: { outcome: 'cancelled' } });
      }, PERMISSION_TIMEOUT_MS);
      timer.unref?.();
      record.pendingPermissions.set(requestId, {
        timer,
        resolve: (response) => {
          if (response.outcome.outcome === 'selected') {
            const chosen = options.find(
              (o) =>
                response.outcome.outcome === 'selected' && o.optionId === response.outcome.optionId,
            );
            if (chosen !== undefined) {
              void this.opts.permissions.recordChoice(record.info.agent.id, toolCall, chosen);
            }
          }
          resolvePromise(response);
        },
      });
    });
  }

  private handleSessionUpdate(record: ThreadRecord, notification: SessionNotification): void {
    record.info.lastActivityAt = Date.now();
    const update: SessionUpdate = notification.update;
    if (update.sessionUpdate === 'current_mode_update' && record.info.modes) {
      record.info.modes = { ...record.info.modes, currentModeId: update.currentModeId };
      this.emitInfo(record);
    }
    if (update.sessionUpdate === 'config_option_update') {
      record.info.configOptions = update.configOptions;
      this.emitInfo(record);
    }
    if (update.sessionUpdate === 'available_commands_update') {
      record.info.availableCommands = update.availableCommands;
      this.emitInfo(record);
    }
    if (record.suppressUpdates) {
      record.lastSuppressedAt = Date.now();
      return;
    }
    this.appendEvent(record, {
      kind: 'session_update',
      update: boundSessionUpdateForLog(update),
      ts: Date.now(),
    });
  }

  private async handleFsRead(
    requestedPath: string,
    line: number | null,
    limit: number | null,
  ): Promise<{ content: string }> {
    const target = await this.confinePath(requestedPath);
    let content: string;
    if (target.docName !== null) {
      content =
        this.opts.getLoadedDocText?.(target.docName) ?? (await readFile(target.abs, 'utf8'));
    } else {
      content = await readFile(target.abs, 'utf8');
    }
    if (line !== null || limit !== null) {
      const lines = content.split('\n');
      const start = Math.max((line ?? 1) - 1, 0);
      const end = limit !== null ? start + limit : lines.length;
      content = lines.slice(start, end).join('\n');
    }
    return { content };
  }

  private async handleFsWrite(
    record: ThreadRecord,
    requestedPath: string,
    content: string,
  ): Promise<void> {
    record.info.lastActivityAt = Date.now();
    const target = await this.confinePath(requestedPath);
    if (target.docName !== null) {
      const session = await this.opts.sessionManager.getSession(
        target.docName,
        record.agentSessionId,
        {
          displayName: record.info.agent.name,
          colorSeed: record.agentSessionId,
          clientName: record.info.agent.id,
        },
      );
      const embedResolver =
        this.opts.resolveEmbed !== undefined
          ? { resolveEmbed: this.opts.resolveEmbed, sourcePath: target.rel }
          : undefined;
      session.dc.document.transact(() => {
        const beforeBlocks = snapshotBlocks(session.dc.document);
        applyAgentMarkdownWrite(
          session.dc.document,
          content,
          'replace',
          embedResolver,
          undefined,
          agentWriteLossDetect(session),
        );
        const changedBlocks =
          changedBlockRange(beforeBlocks, snapshotBlocks(session.dc.document)) ?? undefined;
        const activityMap = session.dc.document.getMap('agent-flash');
        activityMap.set(record.agentSessionId, {
          agentId: record.agentSessionId,
          timestamp: Date.now(),
          type: 'insert',
          description: `Added (${record.info.agent.name}): ${content.slice(0, 50)}`,
          ...(changedBlocks !== undefined ? { changedBlocks } : {}),
        });
      }, session.origin);
      this.setPresence(record, target.docName);
    } else {
      if (this.opts.isIgnoredPath(target.rel)) {
        throw new Error(`path is excluded from the project content scope: ${requestedPath}`);
      }
      const { tracedMkdir, tracedWriteFile } = await import('../fs-traced.ts');
      await tracedMkdir(dirname(target.abs), { recursive: true });
      await tracedWriteFile(target.abs, content);
    }
  }

  private confinePath(
    requestedPath: string,
  ): Promise<{ abs: string; rel: string; docName: string | null }> {
    return confineToContentDir(this.opts.contentDir, requestedPath, this.opts.isExcludedPath);
  }

  private mustGet(threadId: string): ThreadRecord {
    const t = this.threads.get(threadId);
    if (t === undefined) throw new ThreadOpError('unknown-thread', `no thread '${threadId}'`);
    return t;
  }

  private appendEvent(t: ThreadRecord, event: ThreadEvent): void {
    const pending = t.pendingBroadcast;
    if (pending.length > 0 && coalesceChunkInto(pending[pending.length - 1], event, t.info.agent)) {
      return;
    }
    const seq = t.baseSeq + t.events.length;
    t.events.push(event);
    t.info.lastSeq = seq;
    if (t.events.length > EVENT_LOG_LIMIT) {
      const drop = t.events.length - EVENT_LOG_LIMIT;
      t.events.splice(0, drop);
      t.baseSeq += drop;
    }
    if (t.pendingBroadcast.length === 0) t.pendingBroadcastFromSeq = seq;
    t.pendingBroadcast.push(event);
    if (t.flushTimer === null) {
      t.flushTimer = setTimeout(() => this.flushBroadcast(t), EVENT_FLUSH_MS);
      t.flushTimer.unref?.();
    }
  }

  private flushBroadcast(t: ThreadRecord): void {
    if (t.flushTimer !== null) {
      clearTimeout(t.flushTimer);
      t.flushTimer = null;
    }
    if (t.pendingBroadcast.length === 0) return;
    const frame: ThreadServerFrame = {
      op: 'events',
      threadId: t.info.threadId,
      fromSeq: t.pendingBroadcastFromSeq,
      events: t.pendingBroadcast,
    };
    this.persistence.appendEvents(t.info.threadId, t.pendingBroadcast);
    t.pendingBroadcast = [];
    for (const sink of t.subscribers) {
      try {
        sink(frame);
      } catch {}
    }
  }

  private emitStatus(
    t: ThreadRecord,
    status: ThreadStatus,
    detail?: string,
    failure?: ThreadFailureDetail,
  ): void {
    if (status === 'exited' || status === 'error') {
      t.info.queue = undefined;
      this.clearSteer(t);
    }
    t.info.status = status;
    t.info.lastActivityAt = Date.now();
    if (status === 'error' || status === 'auth_required') {
      this.opts.log.warn(
        {
          threadId: t.info.threadId,
          agentId: t.info.agent.id,
          status,
          detail,
          reason: failure?.reason,
          machineDetail: failure?.machineDetail,
        },
        '[acp-threads] thread failure status',
      );
    }
    this.appendEvent(t, {
      kind: 'status',
      status,
      detail,
      ...(failure !== undefined ? { failure } : {}),
      ts: Date.now(),
    });
    this.emitInfo(t);
  }

  private async teardownFailedAgent(t: ThreadRecord): Promise<void> {
    const child = t.child;
    const conn = t.conn;
    const terminals = t.terminals;
    t.child = null;
    t.conn = null;
    t.lastInit = null;
    t.terminals = null;
    try {
      conn?.close();
    } catch {}
    await terminals?.disposeAll().catch((err: unknown) => {
      this.opts.log.warn(
        { err, threadId: t.info.threadId },
        '[acp-threads] terminal cleanup on failed-agent teardown failed',
      );
    });
    if (child !== null) {
      await terminateAgentTree(child, { graceMs: KILL_GRACE_MS });
    }
  }

  private emitInfo(t: ThreadRecord): void {
    this.persistence.queueMetaWrite(t.info.threadId, this.buildMeta(t));
    this.broadcastInfo(t);
  }

  private broadcastInfo(t: ThreadRecord): void {
    for (const sink of t.subscribers) {
      try {
        sink({ op: 'info', info: { ...t.info } });
      } catch {}
    }
  }

  private closeSignInCapture(t: ThreadRecord): void {
    t.authStderr = null;
    if (t.info.signInOutput !== undefined) {
      t.info.signInOutput = undefined;
      this.broadcastInfo(t);
    }
  }

  private buildMeta(t: ThreadRecord): PersistedThreadMeta {
    const { queue: _queue, steer: _steer, signInOutput: _signInOutput, ...info } = t.info;
    return {
      version: 1,
      info,
      sessionId: t.sessionId,
      cwd: t.cwd,
      agentRef: t.agentRef,
      docName: t.docName,
    };
  }

  private failPendingPermissions(t: ThreadRecord): void {
    for (const [requestId, pending] of t.pendingPermissions) {
      clearTimeout(pending.timer);
      pending.resolve({ outcome: { outcome: 'cancelled' } });
      this.appendEvent(t, {
        kind: 'permission_resolved',
        requestId,
        optionId: null,
        auto: true,
        ts: Date.now(),
      });
    }
    t.pendingPermissions.clear();
  }

  private failPendingConsents(t: ThreadRecord): void {
    for (const map of [t.pendingRuntimeConsent, t.pendingPiBridgeConsent]) {
      for (const pending of map.values()) {
        clearTimeout(pending.timer);
        pending.resolve('closed');
      }
      map.clear();
    }
  }

  private setPresence(t: ThreadRecord, currentDoc: string): void {
    const broadcaster = this.opts.agentPresenceBroadcaster;
    if (broadcaster === undefined || broadcaster === null) return;
    try {
      const icon = iconFromClientName(t.info.agent.id);
      const color = AGENT_ICON_COLORS[icon] ?? colorFromSeed(t.agentSessionId);
      broadcaster.setPresence(toBroadcasterKey(t.agentSessionId), {
        displayName: t.info.agent.name,
        icon,
        color,
        currentDoc,
        mode: 'writing',
        ts: Date.now(),
        docTs: Date.now(),
      });
    } catch (err) {
      this.opts.log.warn({ err }, '[acp-threads] presence update failed');
    }
  }

  private reapIdleThreads(): void {
    const now = Date.now();
    const cutoff = now - this.idleReapMs;
    for (const t of this.threads.values()) {
      if (t.info.archived === true) continue;
      if (t.subscribers.size === 0 && !t.turnActive && t.info.lastActivityAt < cutoff) {
        this.opts.log.info({ threadId: t.info.threadId }, '[acp-threads] reaping idle thread');
        this.closeThread(t.info.threadId).catch((err: unknown) => {
          this.opts.log.error({ err, threadId: t.info.threadId }, '[acp-threads] reap failed');
        });
        continue;
      }
      if (!t.turnActive || t.unwatchedSince === null) continue;
      const unwatchedFor = now - t.unwatchedSince;
      if (unwatchedFor >= this.unwatchedTurnKillMs) {
        this.opts.log.warn(
          { threadId: t.info.threadId, unwatchedFor },
          '[acp-threads] force-closing unwatched turn that ignored cancel',
        );
        this.closeThread(t.info.threadId).catch((err: unknown) => {
          this.opts.log.error(
            { err, threadId: t.info.threadId },
            '[acp-threads] force-close failed',
          );
        });
      } else if (unwatchedFor >= this.unwatchedTurnCancelMs && !t.unwatchedCancelSent) {
        t.unwatchedCancelSent = true;
        this.opts.log.warn(
          { threadId: t.info.threadId, unwatchedFor },
          '[acp-threads] cancelling turn running with zero subscribers',
        );
        this.cancel(t.info.threadId);
      }
    }
  }
}

export async function confineToContentDir(
  contentDir: string,
  requestedPath: string,
  isExcludedPath: (relPosix: string) => boolean,
): Promise<{ abs: string; rel: string; docName: string | null }> {
  const contentRoot = await realpath(contentDir);
  const abs = normalize(
    isAbsolute(requestedPath) ? requestedPath : resolve(contentRoot, requestedPath),
  );
  let existing = abs;
  let suffix = '';
  for (;;) {
    try {
      const real = await realpath(existing);
      const resolved = suffix === '' ? real : join(real, suffix);
      const rel = relative(contentRoot, resolved);
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`path escapes the content directory: ${requestedPath}`);
      }
      const mdMatch = /\.(md|mdx)$/.exec(rel);
      let docName: string | null = null;
      if (mdMatch !== null) {
        const candidate = rel.slice(0, -mdMatch[0].length).split(sep).join('/');
        const relPosix = rel.split(sep).join('/');
        if (!isSystemDoc(candidate) && !isConfigDoc(candidate) && !isExcludedPath(relPosix)) {
          docName = candidate;
        }
      }
      return { abs: resolved, rel: rel.split(sep).join('/'), docName };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = dirname(existing);
      if (parent === existing) throw err;
      suffix =
        suffix === ''
          ? abs.slice(parent.length + 1)
          : join(existing.slice(parent.length + 1), suffix);
      existing = parent;
    }
  }
}

function rehydratedRecord(meta: PersistedThreadMeta): ThreadRecord {
  const status = meta.info.status === 'error' ? 'error' : 'exited';
  return {
    info: {
      ...meta.info,
      status,
      archived: true,
      queue: undefined,
      steer: undefined,
      signInOutput: undefined,
    },
    docName: meta.docName,
    agentRef: meta.agentRef,
    cwd: meta.cwd,
    child: null,
    conn: null,
    lastInit: null,
    sessionId: meta.sessionId,
    agentSessionId: `acp-${meta.info.threadId}`,
    events: [],
    baseSeq: meta.info.lastSeq + 1,
    logResolved: false,
    logResolution: null,
    midTurnOnDisk: false,
    resumeInFlight: false,
    authInFlight: false,
    suppressUpdates: false,
    lastSuppressedAt: 0,
    subscribers: new Set(),
    pendingPermissions: new Map(),
    pendingRuntimeConsent: new Map(),
    pendingPiBridgeConsent: new Map(),
    piBridgeDeclined: false,
    lastPiBridgeStatus: null,
    stderrTail: [],
    authStderr: null,
    terminals: null,
    turnActive: false,
    cancelRequested: false,
    steerStallTimer: null,
    unwatchedSince: null,
    unwatchedCancelSent: false,
    pendingBroadcast: [],
    pendingBroadcastFromSeq: 0,
    flushTimer: null,
    closed: false,
    hadUserMessage: true,
    envNotePending: false,
  };
}

function initialConfigValueValid(option: SessionConfigOption, value: string | boolean): boolean {
  if (typeof value === 'boolean') return option.type === 'boolean';
  if (option.type !== 'select') return false;
  for (const entry of option.options) {
    if ('value' in entry) {
      if (entry.value === value) return true;
    } else if (entry.options.some((o) => o.value === value)) {
      return true;
    }
  }
  return false;
}

function declinedRuntimeHint(runtimeKind: ManagedRuntimeKind): string {
  const d = describeRuntime(runtimeKind);
  const installUrl =
    runtimeKind === 'node'
      ? 'https://nodejs.org'
      : 'https://docs.astral.sh/uv/getting-started/installation/';
  return `This agent needs \`${d.provides}\`, which isn't installed. OK can download a private copy of ${d.displayName} for you, or install ${d.displayName} yourself (${installUrl}) and it'll be used automatically.`;
}

function isAuthRequiredError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; data?: unknown };
  if (e.code === AUTH_REQUIRED_CODE) return true;
  if (typeof e.data === 'object' && e.data !== null) {
    const kind = (e.data as { errorKind?: unknown }).errorKind;
    if (kind === 'authentication_failed') return true;
  }
  return false;
}

function agentErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function agentErrorData(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const data = (err as { data?: unknown }).data;
  if (data === undefined || data === null) return undefined;
  try {
    return JSON.stringify(data).slice(0, 300);
  } catch {
    return undefined;
  }
}

function lastFailureMessage(t: ThreadRecord): string | undefined {
  for (let i = t.events.length - 1; i >= 0; i -= 1) {
    const event = t.events[i];
    if (event === undefined || event.kind !== 'status') continue;
    if (event.status !== 'error' && event.status !== 'auth_required') continue;
    return event.detail ?? event.failure?.agentMessage;
  }
  return undefined;
}

function stderrTailDetail(t: ThreadRecord): string | undefined {
  const tail = t.stderrTail.join('\n');
  return tail === '' ? undefined : tail;
}

function joinMachineDetail(...parts: Array<string | undefined>): string | undefined {
  const joined = parts.filter((p): p is string => p !== undefined && p !== '').join('\n');
  return joined === '' ? undefined : joined;
}

function authMachineDetail(err: unknown, t: ThreadRecord): string | undefined {
  const duringSignIn = t.authStderr === null ? undefined : t.authStderr.join('\n');
  return joinMachineDetail(agentErrorData(err), duringSignIn);
}

function threadAuthMethods(methods: InitializeResponse['authMethods']): ThreadAuthMethod[] {
  return (methods ?? []).flatMap((m) => {
    if (typeof m !== 'object' || m === null) return [];
    const { id, name, description, type } = m as {
      id?: unknown;
      name?: unknown;
      description?: unknown;
      type?: unknown;
    };
    if (typeof id !== 'string' || typeof name !== 'string') return [];
    return [
      {
        id,
        name,
        ...(typeof description === 'string' ? { description } : {}),
        ...(typeof type === 'string' ? { kind: type } : {}),
      },
    ];
  });
}
