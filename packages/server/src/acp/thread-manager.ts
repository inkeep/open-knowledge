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
  type SessionNotification,
  type SessionUpdate,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import {
  AGENT_ICON_COLORS,
  AGENT_THREAD_SENTINEL_DOC,
  changedBlockRange,
  colorFromSeed,
  type EditorId,
  iconFromClientName,
} from '@inkeep/open-knowledge-core';
import type {
  ThreadAgentInfo,
  ThreadEvent,
  ThreadInfo,
  ThreadServerFrame,
  ThreadStatus,
} from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { toBroadcasterKey } from '../agent-id.ts';
import type { AgentPresenceBroadcaster } from '../agent-presence.ts';
import {
  type AgentSessionManager,
  applyAgentMarkdownWrite,
  snapshotBlocks,
} from '../agent-sessions.ts';
import { isConfigDoc, isSystemDoc } from '../cc1-broadcast.ts';
import type { PinoLogger } from '../logger.ts';
import { boundSessionUpdateForLog, coalesceChunkInto } from './event-log-bounds.ts';
import {
  AgentLaunchError,
  preflightLaunch,
  type ResolvedLaunch,
  resolveCustomLaunch,
  resolveRegistryLaunch,
  rewriteLaunchToManagedRuntime,
  spawnAcpAgent,
  terminateAgentTree,
} from './launch.ts';
import {
  describeRuntime,
  ensureManagedRuntime,
  findManagedRuntime,
  type ManagedRuntime,
  type ManagedRuntimeKind,
  readRuntimeConsent,
  runtimeDownloadSupported,
  runtimeForInterpreter,
  writeRuntimeConsent,
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
const EVENT_LOG_LIMIT = 5_000;
const DEFAULT_IDLE_REAP_MS = 60 * 60 * 1000;
const REAP_SWEEP_MS = 5 * 60 * 1000;
const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000;
/** How long a launch parks waiting for the user to allow/refuse a runtime download. */
const RUNTIME_CONSENT_TIMEOUT_MS = 5 * 60 * 1000;
/** Trailing throttle for runtime-install progress events (bounds the retained log). */
const RUNTIME_PROGRESS_THROTTLE_MS = 400;
const KILL_GRACE_MS = 5_000;
/** TERM→KILL grace during destroy(): TERM + grace + KILL + force-wait must fit boot's 5s destroy-step budget. */
const DESTROY_KILL_GRACE_MS = 2_000;
/**
 * Trailing-edge coalescing window for live event broadcast. Streaming turns
 * emit one session_update per chunk; sending each as its own WS frame made
 * the client pay a parse + store update + render per chunk. ~40 fps is
 * imperceptible for a transcript and collapses a chunk burst into one frame.
 */
const EVENT_FLUSH_MS = 25;
/** Events per `events` frame during subscribe replay (bounds frame size). */
const REPLAY_CHUNK_SIZE = 512;
/**
 * Token-spend backstop for turns running with zero subscribers (window
 * closed mid-turn, tab crash): the agent keeps generating on the customer's
 * account with nobody watching, and the idle reaper can never collect it —
 * reaping requires an idle turn, and a streaming turn refreshes
 * lastActivityAt on every update. Cancel politely first; force-close if the
 * agent ignores it. Timing is approximate (checked on the reap sweep).
 */
const DEFAULT_UNWATCHED_TURN_CANCEL_MS = 10 * 60 * 1000;
const DEFAULT_UNWATCHED_TURN_KILL_MS = 20 * 60 * 1000;
const STDERR_TAIL_LINES = 40;
/**
 * `session/load` replays history BEFORE its response resolves per protocol,
 * but at least one adapter (Gemini) fires the replay as a floating promise
 * that can straggle past the response. Before opening the first post-resume
 * turn, wait for a short gap with no replayed updates (bounded so a silent
 * agent can't stall the resume).
 */
const RESUME_REPLAY_QUIESCENCE_MS = 300;
const RESUME_REPLAY_MAX_WAIT_MS = 3_000;

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

type Subscriber = (frame: ThreadServerFrame) => void;

interface ThreadRecord {
  info: ThreadInfo;
  /** Extension-less doc the thread was launched from (context only). */
  docName?: string;
  /** Agent reference used to launch — and re-launch on resume. */
  agentRef: { source: 'registry' | 'custom'; id: string };
  /** Session cwd — agents key their session stores by it; resume passes it back verbatim. */
  cwd: string;
  child: ChildProcess | null;
  conn: ClientConnection | null;
  sessionId: string | null;
  /** Writer id for CRDT attribution — `acp-<uuid>`, AGENT_ID_RE-safe. */
  agentSessionId: string;
  events: ThreadEvent[];
  /** seq of events[0]; grows as the log trims. */
  baseSeq: number;
  /** Rehydrated records defer counting disk lines until first subscribe/resume. */
  logResolved: boolean;
  logResolution: Promise<void> | null;
  /** The persisted log ends inside a turn (crash mid-stream) — resume appends a synthetic `turn_ended`. */
  midTurnOnDisk: boolean;
  resumeInFlight: boolean;
  /** Drop incoming `session_update`s (a `session/load` replay duplicating the retained log). */
  suppressUpdates: boolean;
  lastSuppressedAt: number;
  subscribers: Set<Subscriber>;
  pendingPermissions: Map<
    string,
    { resolve: (response: RequestPermissionResponse) => void; timer: ReturnType<typeof setTimeout> }
  >;
  /** In-flight runtime-download consent prompts blocking this thread's launch. */
  pendingRuntimeConsent: Map<
    string,
    {
      runtime: ManagedRuntimeKind;
      resolve: (decision: 'granted' | 'declined' | 'timeout' | 'closed') => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >;
  stderrTail: string[];
  /** ACP terminals this thread's agent asked OK to run; per-spawn, killed with the thread. */
  terminals: AcpTerminalSet | null;
  turnActive: boolean;
  /** A user cancel is in flight for the current turn — a prompt-request
   *  rejection then reads as "cancelled", not an agent error (agents SHOULD
   *  resolve with stopReason 'cancelled', but some abort the request). */
  cancelRequested: boolean;
  /** Since when the thread has had zero subscribers; null while watched. */
  unwatchedSince: number | null;
  /** The unwatched-turn backstop already sent its cancel for this stretch. */
  unwatchedCancelSent: boolean;
  /** Appended-but-unbroadcast events awaiting the coalescing flush. */
  pendingBroadcast: ThreadEvent[];
  /** seq of pendingBroadcast[0]. */
  pendingBroadcastFromSeq: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
  /**
   * A user message has been recorded at some point in this thread's life
   * (this session or, for a rehydrated thread, on disk). Closing a thread that
   * never received one discards it entirely instead of archiving — a spawned
   * agent the user never talked to shouldn't clutter conversation history.
   */
  hadUserMessage: boolean;
  /**
   * The user's raw typed text (create brief / instruction), carried on the
   * launch so the first-prompt title derives from it instead of the composed
   * prompt's fixed handoff preamble. Consumed and cleared on the first title
   * adoption in {@link AcpThreadManager.echoUserMessage}; absent (bare launch)
   * falls back to the prompt content.
   */
  titleHint?: string;
}

/** A `probeHarnessManagedMcpEntry` hit — where OK's own managed entry was found. */
export interface HarnessManagedMcpEntryHit {
  editorId: EditorId;
  scope: 'project' | 'user';
  configPath: string;
}

export interface AcpThreadManagerOptions {
  contentDir: string;
  /** `<projectDir>/.ok/local` — custom agents, permission grants, registry cache. */
  localDir: string;
  registry: AcpRegistry;
  permissions: AcpPermissionStore;
  sessionManager: AgentSessionManager;
  agentPresenceBroadcaster?: AgentPresenceBroadcaster | null;
  /** Wiki-embed resolver threaded into markdown writes (same seam the HTTP agent-write handlers use). */
  resolveEmbed?: (basename: string, sourcePath: string) => string | null;
  /** Membership test for the content scope (ContentFilter.isExcluded complement). */
  isExcludedPath: (relPath: string) => boolean;
  /**
   * Security-boundary test for NON-markdown fs writes: true when the path is
   * excluded by ignore rules or the builtin skip dirs (`.ok/`, `.git/`,
   * `node_modules/`, …) — `ContentFilter.isPathIgnored`, which skips the
   * sibling-asset admission heuristic so legitimate asset writes into
   * markdown-less directories still land. Without this gate the plain-disk
   * branch of the fs-write proxy would happily write into `.ok/local/` (custom
   * agent definitions → arbitrary command execution) or `.git/hooks/`.
   */
  isIgnoredPath: (relPosix: string) => boolean;
  /**
   * Live `Y.Text('source')` bytes for a currently-loaded doc, or null when the
   * doc isn't loaded. Lets `fs/read_text_file` serve unsaved editor state for
   * open docs without opening (and leaking) a tracked agent session — closed
   * docs fall back to the persisted disk bytes, which equal the CRDT bytes when
   * quiescent.
   */
  getLoadedDocText?: (docName: string) => string | null;
  /** Origin the auto-forwarded MCP server is reachable at (post-listen). */
  getServerUrl?: () => string;
  /**
   * Build the stdio `ok mcp` command handed to agents that DON'T advertise
   * HTTP-MCP support, so OK tools still reach them. Returns null when the host
   * can't resolve a CLI entrypoint (the HTTP path is preferred when available).
   */
  getMcpStdioCommand?: () => { command: string; args: readonly string[] } | null | undefined;
  /**
   * Whether the agent's own harness will already load OK's managed MCP entry
   * from the editor config OK's wiring installs at `cwd` (project scope) or in
   * the user's home (user scope). On a hit, session setup skips injecting the
   * `open-knowledge` server — both copies claim the same server name and
   * harnesses resolve that collision in their own favor, so injecting a
   * duplicate only creates a same-name fight the injected copy loses. Absent
   * seam / miss / throw all fall back to injecting (prior behavior). Wired by
   * `bootServer()` callers to the CLI's `probeOwnManagedEditorMcpEntry`; the
   * Vite dev server leaves it unwired (dev-shape entries never exact-match).
   */
  probeHarnessManagedMcpEntry?: (
    editorId: EditorId,
    cwd: string,
  ) => HarnessManagedMcpEntryHit | null | Promise<HarnessManagedMcpEntryHit | null>;
  /**
   * Test seam for the managed-runtime download path — override the install
   * cache root, the download `fetch`, and the consent-store home so a test can
   * drive the consent/download flow without touching the real `~/.ok` or the
   * network. Unset in production (defaults resolve to `~/.ok/runtimes` +
   * global `fetch` + `~/.ok`).
   */
  runtimeInstall?: {
    root?: string;
    fetchImpl?: typeof fetch;
    consentHome?: string;
  };
  log: PinoLogger;
  maxThreads?: number;
  idleReapMs?: number;
  /** Unwatched-mid-turn backstop: politely cancel after this long with zero subscribers. */
  unwatchedTurnCancelMs?: number;
  /** …and force-close the thread if the turn is STILL running after this long. */
  unwatchedTurnKillMs?: number;
}

/**
 * Build the stdio command that launches the OK MCP shim (`ok mcp --port <n>`)
 * pinned to this server's HTTP MCP endpoint. `localOpCliArgs` is how the host
 * invokes the OK CLI in its runtime (`[execPath, entry]` under `ok start` / the
 * packaged app); it degrades to a bare `open-knowledge` on PATH when the host
 * can't resolve one (e.g. the Vite dev server).
 */
export function buildOkMcpStdioCommand(
  localOpCliArgs: readonly string[] | undefined,
  port: number,
): { command: string; args: string[] } {
  const argv = localOpCliArgs && localOpCliArgs.length > 0 ? localOpCliArgs : ['open-knowledge'];
  const [command = 'open-knowledge', ...rest] = argv;
  return { command, args: [...rest, 'mcp', '--port', String(port)] };
}

export class AcpThreadManager {
  private readonly opts: AcpThreadManagerOptions;
  private readonly threads = new Map<string, ThreadRecord>();
  private readonly reapTimer: ReturnType<typeof setInterval>;
  private readonly maxThreads: number;
  private readonly idleReapMs: number;
  private readonly unwatchedTurnCancelMs: number;
  private readonly unwatchedTurnKillMs: number;
  private readonly persistence: ThreadPersistenceStore;
  private destroyed = false;
  private initialized = false;

  constructor(opts: AcpThreadManagerOptions) {
    this.opts = opts;
    this.maxThreads = opts.maxThreads ?? MAX_ACP_THREADS;
    this.idleReapMs = opts.idleReapMs ?? DEFAULT_IDLE_REAP_MS;
    this.unwatchedTurnCancelMs = opts.unwatchedTurnCancelMs ?? DEFAULT_UNWATCHED_TURN_CANCEL_MS;
    this.unwatchedTurnKillMs = opts.unwatchedTurnKillMs ?? DEFAULT_UNWATCHED_TURN_KILL_MS;
    this.persistence = new ThreadPersistenceStore(opts.localDir, opts.log);
    this.reapTimer = setInterval(() => this.reapIdleThreads(), REAP_SWEEP_MS);
    this.reapTimer.unref?.();
  }

  /**
   * Rehydrate archived threads from `.ok/local/threads/` — metadata only;
   * each thread's event log loads lazily on its first subscribe/resume, so
   * boot cost stays O(#threads) small-file reads. Await before serving the
   * `/collab/thread` socket so `list` never races the scan.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
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
    // Seqs below the in-memory window (an archived/rehydrated thread, or a
    // live log that trimmed past 5k events) replay from disk first. Looped:
    // `baseSeq` only ever grows, and a concurrent archive during the async
    // read moves the memory window onto disk — without the re-check those
    // events would fall between the disk pass and the memory pass.
    let diskCursor = from;
    while (diskCursor < t.baseSeq) {
      const target = t.baseSeq;
      await this.persistence.whenIdle(threadId);
      await this.persistence.readEvents(threadId, diskCursor, target, (chunkFrom, events) => {
        sink({ op: 'events', threadId, fromSeq: chunkFrom, events });
      });
      diskCursor = target;
    }
    // Flush the coalescing buffer, then replay the memory window and attach —
    // all synchronous, so nothing lands between the replay and the live feed.
    // Events appended DURING the disk pass are covered here (bounds are
    // recomputed after the awaits).
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

  /**
   * Resolve the on-disk log's line count (== next seq) once per rehydrated
   * record — the persisted meta's `lastSeq` can be stale after a crash (meta
   * rewrites only on info changes, not per event). Memoized; live records are
   * born resolved.
   */
  private ensureLogResolved(t: ThreadRecord): Promise<void> {
    if (t.logResolved) return Promise.resolve();
    t.logResolution ??= (async () => {
      const resolved = await this.persistence.resolveEventLog(t.info.threadId);
      t.baseSeq = resolved.count;
      t.midTurnOnDisk = resolved.midTurn;
      t.info.lastSeq = resolved.count - 1;
      t.logResolved = true;
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

  /**
   * Create a thread: resolve the agent, spawn it, run the ACP handshake, and
   * (optionally) send the launch prompt. Resolves as soon as the thread
   * record exists — handshake progress streams as `status` events so the UI
   * can render the spawning/installing states live.
   */
  async createThread(params: {
    agent: { source: 'registry' | 'custom'; id: string };
    prompt?: string;
    docName?: string;
    titleHint?: string;
  }): Promise<ThreadInfo> {
    if (this.destroyed) throw new ThreadOpError('capacity', 'server is shutting down');
    if (this.liveThreadCount() >= this.maxThreads) {
      throw new ThreadOpError('capacity', `maximum of ${this.maxThreads} concurrent agent threads`);
    }

    const { info: agentInfo, custom } = await this.resolveAgentInfo(params.agent);
    // Re-check both gates after the await: resolveAgentInfo does file/registry
    // I/O and the socket dispatches frames as independent async tasks, so a
    // burst of creates can all pass the pre-await guard on the same count.
    // No await sits between this check and the insert below, so it's atomic.
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
        modes: null,
        configOptions: null,
        lastSeq: -1,
        archived: false,
      },
      docName: params.docName,
      agentRef: { source: params.agent.source, id: params.agent.id },
      cwd: this.opts.contentDir,
      child: null,
      conn: null,
      sessionId: null,
      agentSessionId: `acp-${threadId}`,
      events: [],
      baseSeq: 0,
      logResolved: true,
      logResolution: null,
      midTurnOnDisk: false,
      resumeInFlight: false,
      suppressUpdates: false,
      lastSuppressedAt: 0,
      subscribers: new Set(),
      pendingPermissions: new Map(),
      pendingRuntimeConsent: new Map(),
      stderrTail: [],
      terminals: null,
      turnActive: false,
      cancelRequested: false,
      // Born unwatched — the creating socket subscribes right after `created`.
      unwatchedSince: now,
      unwatchedCancelSent: false,
      pendingBroadcast: [],
      pendingBroadcastFromSeq: 0,
      flushTimer: null,
      closed: false,
      hadUserMessage: false,
      titleHint: params.titleHint,
    };
    this.threads.set(threadId, record);
    this.emitStatus(record, 'installing');

    // Handshake runs async — errors land as status events, not throws.
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
      // A registry failure (network outage, cache parse error) is NOT
      // "unknown agent" — that would misdirect the user toward a
      // nonexistent-agent explanation when the real problem is transient.
      throw new ThreadOpError(
        'install-failed',
        `agent registry unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (manifest === undefined) {
      throw new ThreadOpError('unknown-agent', `agent '${agent.id}' is not in the registry`);
    }
    return {
      info: { id: manifest.id, name: manifest.name, iconUrl: manifest.icon, source: 'registry' },
      custom: null,
    };
  }

  /**
   * Resolve the launch, spawn the agent, wire its process/connection
   * handlers, and run `initialize` — the half of the handshake shared by
   * first start and resume. Returns null when the record closed mid-flight.
   * Throws (AgentLaunchError / ThreadOpError) on failure; callers map to
   * status events (create) or a rejected op (resume).
   */
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

    // Ensure the launch command exists. If the interpreter (npx/uvx) is
    // missing, offer to download a managed runtime (consent-gated) and rewrite
    // the launch to use it; otherwise this throws an actionable install hint
    // rather than letting the missing command surface as an opaque async
    // `spawn ENOENT`.
    const launchable = await this.ensureLaunchable(record, launch);
    if (launchable === null) return null;
    launch = launchable;
    if (record.closed) return null;

    this.emitStatus(record, 'spawning');
    const child = spawnAcpAgent(launch, record.cwd);
    record.child = child;

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim() === '') continue;
        record.stderrTail.push(line.slice(0, 500));
        if (record.stderrTail.length > STDERR_TAIL_LINES) record.stderrTail.shift();
      }
    });
    child.on('error', (err) => {
      this.emitStatus(record, 'error', `agent failed to start: ${err.message}`);
    });
    child.on('exit', (code, signal) => {
      record.child = null;
      // Commands the agent asked OK to run die with the agent — nothing
      // should keep executing for a conversation that can no longer see it.
      record.terminals?.disposeAll().catch((err: unknown) => {
        this.opts.log.warn(
          { err, threadId: record.info.threadId },
          '[acp-threads] terminal cleanup on agent exit failed',
        );
      });
      if (record.closed || record.info.archived === true) return;
      const tail = record.stderrTail.slice(-10).join('\n');
      this.emitStatus(
        record,
        record.info.status === 'error' ? 'error' : 'exited',
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

    // Fresh per spawn: a resume respawns the agent, and terminals from the
    // previous process are dead by construction (disposed on its exit).
    const terminals = new AcpTerminalSet({
      defaultCwd: record.cwd,
      emit: (event) => this.appendEvent(record, event),
      log: this.opts.log,
    });
    record.terminals = terminals;

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
        // A rejected `closed` (transport-level protocol error rather than a
        // clean close) must not become an unhandled rejection — subscribers
        // still need the terminal status event.
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
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
          session: { configOptions: { boolean: {} } },
        },
      });
    } catch (err) {
      throw new ThreadOpError('spawn-failed', `initialize failed: ${describeAgentError(err)}`);
    }
    if (record.closed) return null;
    return { conn, init, launch };
  }

  /**
   * Preflight the launch; on a missing npx/uvx interpreter, resolve a managed
   * runtime (already-installed → persisted-consent → interactive consent →
   * download) and return the rewritten launch. Returns null only when the
   * thread closed mid-flight; throws an actionable {@link AgentLaunchError} on
   * decline / unsupported platform / failed install (callers map it to an
   * error status).
   */
  private async ensureLaunchable(
    record: ThreadRecord,
    launch: ResolvedLaunch,
  ): Promise<ResolvedLaunch | null> {
    try {
      await preflightLaunch(launch);
      return launch;
    } catch (err) {
      if (!(err instanceof AgentLaunchError) || err.code !== 'command-not-found') throw err;
      // Only npx/uvx have a managed fallback — a binary/custom command doesn't.
      if (launch.kind !== 'npx' && launch.kind !== 'uvx') throw err;
      const runtimeKind = runtimeForInterpreter(launch.kind);
      // No download target for this platform → keep the original install hint.
      if (!runtimeDownloadSupported(runtimeKind)) throw err;
      const runtime = await this.provideManagedRuntime(record, runtimeKind);
      if (runtime === null) return null; // closed mid-flight
      const rewritten = rewriteLaunchToManagedRuntime(launch, runtime);
      // The managed launcher must itself be executable before we spawn it.
      await preflightLaunch(rewritten);
      return rewritten;
    }
  }

  /**
   * Return a managed runtime for `runtimeKind`, downloading it if the user
   * consents. Null means the thread closed while we waited; a throw means the
   * user declined (or the install failed) and the launch can't proceed.
   */
  private async provideManagedRuntime(
    record: ThreadRecord,
    runtimeKind: ManagedRuntimeKind,
  ): Promise<ManagedRuntime | null> {
    const root = this.opts.runtimeInstall?.root;
    const existing = await findManagedRuntime(runtimeKind, root).catch(() => null);
    if (existing !== null) return existing;

    const persisted = (await readRuntimeConsent(this.opts.runtimeInstall?.consentHome))[
      runtimeKind
    ];
    const decision = persisted ?? (await this.requestRuntimeConsent(record, runtimeKind));
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

  /**
   * Emit a `runtime_consent_request` (retained + replayed like a permission
   * prompt) and park until the user answers via a `runtime_consent_response`
   * frame, the request times out, or the thread closes.
   */
  private requestRuntimeConsent(
    record: ThreadRecord,
    runtimeKind: ManagedRuntimeKind,
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
      }, RUNTIME_CONSENT_TIMEOUT_MS);
      timer.unref?.();
      record.pendingRuntimeConsent.set(requestId, {
        runtime: runtimeKind,
        resolve: resolvePromise,
        timer,
      });
    });
  }

  /** Answer a parked runtime-consent prompt from the client. */
  respondRuntimeConsent(
    threadId: string,
    requestId: string,
    outcome: { kind: 'granted'; remember?: boolean } | { kind: 'declined'; remember?: boolean },
  ): void {
    const t = this.mustGet(threadId);
    const pending = t.pendingRuntimeConsent.get(requestId);
    if (pending === undefined) return;
    t.pendingRuntimeConsent.delete(requestId);
    clearTimeout(pending.timer);
    const decision = outcome.kind === 'granted' ? 'granted' : 'declined';
    if (outcome.remember === true) {
      void writeRuntimeConsent(
        pending.runtime,
        decision,
        this.opts.log,
        this.opts.runtimeInstall?.consentHome,
      );
    }
    this.appendEvent(t, {
      kind: 'runtime_consent_resolved',
      requestId,
      decision,
      ts: Date.now(),
    });
    pending.resolve(decision);
  }

  /** Download + install a consented runtime, streaming progress to subscribers. */
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
  ): Promise<McpServer[]> {
    if ((await this.harnessAlreadyHasOkMcp(record)) !== null) return [];
    const mcpServers: McpServer[] = [];
    const serverUrl = this.opts.getServerUrl?.();
    if (serverUrl !== undefined && init.agentCapabilities?.mcpCapabilities?.http === true) {
      // Preferred: a direct HTTP MCP connection to this running server.
      mcpServers.push({
        type: 'http',
        name: 'open-knowledge',
        url: `${serverUrl}/mcp`,
        headers: [],
      });
    } else {
      // Fallback for agents that don't advertise HTTP-MCP support (e.g. Claude
      // Code's ACP adapter): a stdio MCP server. stdio needs no capability flag
      // — every ACP agent accepts it — so this is what actually carries the OK
      // tools to non-HTTP agents. Without it they connect with only their own
      // personal MCP config and OK tools are silently absent (verified: Codex
      // declares http and gets OK tools; Claude does not and got only its own).
      const stdio = this.opts.getMcpStdioCommand?.();
      if (stdio !== null && stdio !== undefined) {
        mcpServers.push({
          name: 'open-knowledge',
          command: stdio.command,
          args: [...stdio.args],
          env: [],
        });
      }
    }
    return mcpServers;
  }

  /**
   * Non-null when this agent's harness will already load OK's own managed
   * MCP entry from the project/user editor config, so injecting our copy
   * would only stage a same-name collision (see `probeHarnessManagedMcpEntry`
   * on the options). Fail-open: no seam, unmapped/custom agent, probe miss,
   * or probe throw all return null and injection proceeds.
   */
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

  private async startThread(
    record: ThreadRecord,
    params: { agent: { source: 'registry' | 'custom'; id: string }; prompt?: string },
    custom: CustomAgentEntry | null,
  ): Promise<void> {
    let handshake: Awaited<ReturnType<AcpThreadManager['connectAgent']>>;
    try {
      handshake = await this.connectAgent(record, custom);
    } catch (err) {
      const detail =
        err instanceof AgentLaunchError || err instanceof ThreadOpError ? err.message : String(err);
      this.emitStatus(record, 'error', detail);
      return;
    }
    if (handshake === null) return;
    const { conn, init, launch } = handshake;

    const mcpServers = await this.buildMcpServers(record, init);
    try {
      const session = await conn.agent.request(acpMethods.agent.session.new, {
        cwd: record.cwd,
        mcpServers,
      });
      record.sessionId = session.sessionId;
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
      const authMethods = (init.authMethods ?? [])
        .map((m) => (typeof m === 'object' && m !== null ? (m as { name?: string }).name : null))
        .filter((n): n is string => typeof n === 'string');
      if (authMethods.length > 0) {
        this.emitStatus(
          record,
          'auth_required',
          `sign in first (${authMethods.join(' / ')}), then start a new thread — ${describeAgentError(err)}`,
        );
      } else {
        this.emitStatus(record, 'error', `session setup failed: ${describeAgentError(err)}`);
      }
      return;
    }
    if (record.closed) return;

    this.setPresence(record, 'idle');
    this.emitStatus(record, 'ready');
    // Startup latency is a known UX sore point (npx resolution + node boot +
    // handshake, serialized) — keep it measurable per launch kind.
    this.opts.log.info(
      {
        threadId: record.info.threadId,
        agentId: record.info.agent.id,
        launchKind: launch.kind,
        msToReady: Date.now() - record.info.createdAt,
      },
      '[acp-threads] agent ready',
    );

    if (params.prompt !== undefined && params.prompt !== '') {
      this.sendPrompt(record.info.threadId, params.prompt);
    }
  }

  /**
   * Resume an archived thread: respawn its agent and reconnect the stored
   * ACP session. Preference order `session/resume` (no history replay — the
   * retained transcript is already the source of truth) over `session/load`
   * (protocol-mandated full replay, suppressed as duplicates), else fail
   * with `resume-unsupported`. Unlike `createThread`, resolves only once the
   * thread is ready (or rejects) — status events stream progress meanwhile.
   */
  async resumeThread(threadId: string, prompt?: string): Promise<ThreadInfo> {
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
      // Re-check both gates after the awaits (same TOCTOU class as
      // createThread): a concurrent create can pass its own guard while this
      // resume is suspended, and un-archiving below is what raises the live
      // count. No await sits between this check and the flip.
      if (this.destroyed) throw new ThreadOpError('capacity', 'server is shutting down');
      if (this.liveThreadCount() >= this.maxThreads) {
        throw new ThreadOpError(
          'capacity',
          `maximum of ${this.maxThreads} concurrent agent threads`,
        );
      }
      t.info.agent = agentInfo;
      t.info.archived = false;
      t.stderrTail = [];
      if (t.midTurnOnDisk) {
        // The persisted log ended inside a turn (crash mid-stream) — close
        // it so the folded transcript doesn't read as still-running.
        t.midTurnOnDisk = false;
        this.appendEvent(t, { kind: 'turn_ended', stopReason: 'cancelled', ts: Date.now() });
      }
      if (prompt !== undefined && prompt !== '') {
        // Optimistic echo: the message lands in the transcript (and every
        // subscriber's view) NOW, not after the multi-second respawn +
        // handshake — otherwise the composer clears and nothing visibly
        // happens until the agent is up. `dispatchPrompt` at the end of the
        // handshake skips its own echo to match. Flushed synchronously so
        // the echo frame always precedes the `resumed` response, not just
        // usually (the coalescing timer could lose to a fast handshake).
        this.echoUserMessage(t, prompt);
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
        const mcpServers = await this.buildMcpServers(t, init);
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
        const modes = response.modes as ThreadInfo['modes'] | undefined;
        if (modes !== undefined && modes !== null) t.info.modes = modes;
        const configOptions = response.configOptions as ThreadInfo['configOptions'] | undefined;
        if (configOptions !== undefined && configOptions !== null) {
          t.info.configOptions = configOptions;
        }
        this.setPresence(t, 'idle');
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
        if (prompt !== undefined && prompt !== '') {
          this.dispatchPrompt(t, prompt, { echo: false });
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
        // A rejected session/load|resume (unknown or expired sessionId, cwd
        // mismatch) — expected at steady state: agents expire their own
        // session stores (Claude defaults to 30 days).
        throw new ThreadOpError(
          'resume-unsupported',
          `couldn't resume the previous session: ${describeAgentError(err)}`,
        );
      }
    } finally {
      t.resumeInFlight = false;
    }
  }

  /** Tear down a half-resumed agent and return the record to archived rest. */
  private async abortResume(t: ThreadRecord): Promise<void> {
    t.closed = true;
    t.suppressUpdates = false;
    this.failPendingPermissions(t);
    this.failPendingRuntimeConsent(t);
    try {
      t.conn?.close();
    } catch {
      // Already closed.
    }
    const child = t.child;
    if (child !== null) {
      await terminateAgentTree(child, { graceMs: DESTROY_KILL_GRACE_MS });
    }
    t.child = null;
    t.conn = null;
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

  /**
   * Wait for the `session/load` replay stream to go quiet (see
   * RESUME_REPLAY_QUIESCENCE_MS) before the first post-resume turn opens.
   */
  private async awaitReplayQuiescence(t: ThreadRecord): Promise<void> {
    const deadline = Date.now() + RESUME_REPLAY_MAX_WAIT_MS;
    while (Date.now() - t.lastSuppressedAt < RESUME_REPLAY_QUIESCENCE_MS && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  sendPrompt(threadId: string, content: string): void {
    const t = this.mustGet(threadId);
    if (t.info.archived === true) {
      throw new ThreadOpError('not-ready', 'the thread is archived — resume it first');
    }
    if (t.resumeInFlight) {
      // Mid-resume the connection exists before the session is reconnected —
      // a prompt slipping in here would race the session/resume|load request.
      throw new ThreadOpError('not-ready', 'the thread is still resuming');
    }
    if (t.sessionId === null || t.conn === null) {
      throw new ThreadOpError('not-ready', 'thread has no live agent session');
    }
    if (t.turnActive) {
      throw new ThreadOpError('not-ready', 'a turn is already running — cancel it first');
    }
    this.dispatchPrompt(t, content, { echo: true });
  }

  /** Adopt-title + append the `user_message` transcript event for a prompt. */
  private echoUserMessage(t: ThreadRecord, content: string): void {
    // The single choke point for every user message (launch prompt, interactive
    // prompt, resume prompt) — mark the thread as touched so a later close
    // archives it rather than discarding it as never-used.
    t.hadUserMessage = true;
    if (t.info.title === t.info.agent.name && content.trim() !== '') {
      // Prefer the user's raw typed text (carried on the launch) over the
      // composed prompt — its fixed handoff preamble would otherwise become
      // the tab label. One-shot: cleared so later prompts derive from content.
      const source = t.titleHint !== undefined && t.titleHint.trim() !== '' ? t.titleHint : content;
      t.titleHint = undefined;
      t.info.title = deriveThreadTitle(source);
      this.appendEvent(t, { kind: 'title_changed', title: t.info.title, ts: Date.now() });
      this.emitInfo(t);
    }
    this.appendEvent(t, { kind: 'user_message', content, ts: Date.now() });
  }

  /**
   * Manually retitle a thread (tab double-click). Works on live and archived
   * threads; a manual title differs from the agent name, so the first-prompt
   * adoption in {@link echoUserMessage} will not overwrite it.
   */
  async renameThread(threadId: string, rawTitle: string): Promise<void> {
    const t = this.mustGet(threadId);
    if (t.closed) {
      // Mid-teardown, closeThread is about to reset the memory window — an
      // event appended here would be dropped after its seq was claimed.
      throw new ThreadOpError('not-ready', 'the thread is closing');
    }
    const title = clampThreadTitle(rawTitle);
    if (title === '' || title === t.info.title) return;
    // Appending to a rehydrated record before its log is resolved would trust
    // a possibly-stale `baseSeq` and break the line-index-IS-the-seq contract.
    await this.ensureLogResolved(t);
    t.info.title = title;
    t.info.lastActivityAt = Date.now();
    this.appendEvent(t, { kind: 'title_changed', title, ts: Date.now() });
    this.flushBroadcast(t);
    this.emitInfo(t);
    // Durable on return: a rename is rare and tiny, and archived threads have
    // no later flush point to ride.
    await this.persistence.whenIdle(t.info.threadId);
  }

  /**
   * Open a turn and send the prompt to the agent. `echo: false` is the
   * resume path, whose optimistic echo already put the user message (and
   * title adoption) in the transcript at resume start.
   */
  private dispatchPrompt(t: ThreadRecord, content: string, opts: { echo: boolean }): void {
    if (t.sessionId === null || t.conn === null) {
      throw new ThreadOpError('not-ready', 'thread has no live agent session');
    }
    if (opts.echo) {
      this.echoUserMessage(t, content);
    }
    t.turnActive = true;
    t.cancelRequested = false;
    this.appendEvent(t, { kind: 'turn_started', ts: Date.now() });
    this.emitStatus(t, 'running');
    this.setPresence(t, 'writing');

    const sessionId = t.sessionId;
    t.conn.agent
      .request(acpMethods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text: content }],
      })
      .then((response) => {
        t.turnActive = false;
        if (t.closed) return;
        this.appendEvent(t, {
          kind: 'turn_ended',
          stopReason: response.stopReason,
          ts: Date.now(),
        });
        this.emitStatus(t, 'ready');
        this.setPresence(t, 'idle');
      })
      .catch((err) => {
        t.turnActive = false;
        if (t.closed) return;
        this.appendEvent(t, { kind: 'turn_ended', stopReason: 'cancelled', ts: Date.now() });
        if (t.cancelRequested) {
          // The user asked for this — an aborted request is a completed
          // cancel, not an agent failure.
          this.emitStatus(t, 'ready');
        } else {
          this.emitStatus(t, 'error', `prompt failed: ${describeAgentError(err)}`);
        }
        this.setPresence(t, 'idle');
      });
  }

  cancel(threadId: string): void {
    const t = this.mustGet(threadId);
    if (t.conn === null || t.sessionId === null) return;
    if (t.turnActive) t.cancelRequested = true;
    // Per ACP, a cancelled turn's pending permission requests resolve as
    // 'cancelled' client-side — and a turn blocked ON a permission prompt
    // only actually stops when we do (the agent is awaiting our response).
    this.failPendingPermissions(t);
    this.restoreRunningAfterPermission(t);
    void t.conn.agent.notify(acpMethods.agent.session.cancel, { sessionId: t.sessionId });
  }

  setMode(threadId: string, modeId: string): void {
    const t = this.mustGet(threadId);
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

  /**
   * Set a session config option (model picker, thought level, …). The
   * response's `configOptions` is the agent's authoritative post-change
   * state — it replaces the cached array wholesale (option changes can
   * cascade, e.g. picking a model can reshape the thought-level choices).
   */
  setConfigOption(threadId: string, configId: string, value: string | boolean): void {
    const t = this.mustGet(threadId);
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

  /**
   * Un-park the status once no permission prompt remains. Guarded on the
   * status still being `awaiting_permission` so a terminal transition
   * (error/exited) that landed in between is never overwritten.
   */
  private restoreRunningAfterPermission(t: ThreadRecord): void {
    if (
      t.pendingPermissions.size === 0 &&
      t.turnActive &&
      t.info.status === 'awaiting_permission'
    ) {
      this.emitStatus(t, 'running');
    }
  }

  /**
   * Close a thread: kill its agent (resolving only once the process tree is
   * actually dead — resolving earlier lets the server exit before the SIGKILL
   * escalation can fire), then ARCHIVE it — unless it never received a user
   * message, in which case it is DISCARDED (record + persisted log removed) so
   * a spawned-but-untouched agent leaves no history. An archived record stays
   * listed with `archived: true`; its transcript is already on disk and the
   * stored sessionId keeps it resumable. `destroy()` passes a shorter grace so
   * parallel closes fit inside boot's per-step destroy timeout.
   */
  async closeThread(threadId: string, opts?: { killGraceMs?: number }): Promise<void> {
    const t = this.threads.get(threadId);
    if (t === undefined || t.info.archived === true || t.closed) return;
    t.closed = true; // Suppress exit/conn status handlers during teardown.
    this.failPendingPermissions(t);
    this.failPendingRuntimeConsent(t);
    try {
      t.conn?.close();
    } catch {
      // Already closed.
    }
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
    await t.terminals?.disposeAll();
    t.terminals = null;
    this.opts.agentPresenceBroadcaster?.clearPresence(toBroadcasterKey(t.agentSessionId));
    await this.opts.sessionManager.closeAllForAgent(t.agentSessionId).catch((err) => {
      this.opts.log.warn({ err, threadId }, '[acp-threads] session cleanup failed');
    });
    // Never-used thread (no user message ever recorded): discard it rather than
    // archive. The agent is dead above; drop the record and its (possibly
    // partial) persisted log so a spawned-but-untouched agent leaves no history.
    if (!t.hadUserMessage) {
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
      // Close the open turn so the persisted transcript doesn't fold as
      // still-running when replayed later.
      t.turnActive = false;
      this.appendEvent(t, { kind: 'turn_ended', stopReason: 'cancelled', ts: Date.now() });
    }
    t.info.archived = true;
    this.emitStatus(t, 'exited', 'thread closed');
    this.flushBroadcast(t);
    this.persistence.queueMetaWrite(threadId, this.buildMeta(t));
    await this.persistence.whenIdle(threadId);
    // Release the in-memory window — disk now holds the whole log. (The
    // record was born resolved or resolved on first subscribe; either way
    // `lastSeq` is accurate here.)
    t.baseSeq = t.info.lastSeq + 1;
    t.events = [];
    t.pendingBroadcast = [];
    t.closed = false; // Archived records stay addressable (subscribe/resume/delete).
    this.opts.log.info({ threadId }, '[acp-threads] thread archived');
  }

  /** Permanently delete an ARCHIVED thread's transcript and metadata. */
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

  // ── ACP client-side handlers ────────────────────────────────────────────

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
    // The turn is parked on the user now — say so in the tab strip instead of
    // a generic "running" spinner. Only refine 'running': a terminal status
    // (error/exited) always wins, so a dead turn's stale request never reads
    // as still inviting approval.
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
    if (record.suppressUpdates) {
      // A session/load replay — every update duplicates the retained log
      // (which is richer: permission events, statuses). Live state above
      // still applied; the transcript append is skipped.
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
      // In-scope markdown: serve the live CRDT bytes when the doc is loaded
      // (OK's equivalent of the protocol's "unsaved editor state"); otherwise
      // read the persisted disk bytes. No tracked agent session is opened for
      // a read — that would leak a DirectConnection per distinct doc.
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
        applyAgentMarkdownWrite(session.dc.document, content, 'replace', embedResolver);
        // Same-transaction flash entry, mirroring the HTTP agent-write
        // handlers — drives the editor's write-flash + follow-the-write
        // animation for thread writes too (and rides the per-session
        // UndoManager, which tracks the agent-flash map). `changedBlocks` lets
        // an editor that follow-mode activates AFTER this write applied still
        // scroll to + flash the changed section (no live transaction to diff).
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
      this.setPresence(record, 'writing', target.docName);
    } else {
      // Non-markdown (and filter-excluded markdown) writes hit the disk
      // directly — but never inside an ignored namespace. `.ok/` and `.git/`
      // live INSIDE the confined root (content.dir defaults to `.`), so the
      // `..`-escape check alone does not protect them.
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

  // ── internals ───────────────────────────────────────────────────────────

  private mustGet(threadId: string): ThreadRecord {
    const t = this.threads.get(threadId);
    if (t === undefined) throw new ThreadOpError('unknown-thread', `no thread '${threadId}'`);
    return t;
  }

  private appendEvent(t: ThreadRecord, event: ThreadEvent): void {
    // Fold a streamed text chunk into the current unflushed tail event instead
    // of giving each its own seq/line — collapses a per-word chunk burst into
    // ~one event per flush window. Eligible only against the pending (not-yet-
    // flushed) tail: a flushed event's seq is already on the wire and on disk,
    // so `pendingBroadcast` non-empty means its last event === events[] tail and
    // is still ours to grow. A fold consumes no seq, preserving line-index==seq.
    // pendingBroadcast non-empty also implies a flush timer is already pending
    // (set when it went non-empty below), so the fold needs no new timer.
    const pending = t.pendingBroadcast;
    if (pending.length > 0 && coalesceChunkInto(pending[pending.length - 1], event)) {
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
    // Durability rides the same coalescing cadence: one serialized append
    // per flushed batch, in seq order (the NDJSON line index IS the seq).
    this.persistence.appendEvents(t.info.threadId, t.pendingBroadcast);
    t.pendingBroadcast = [];
    for (const sink of t.subscribers) {
      try {
        sink(frame);
      } catch {
        // A broken sink is dropped by its socket's close handler.
      }
    }
  }

  private emitStatus(t: ThreadRecord, status: ThreadStatus, detail?: string): void {
    t.info.status = status;
    t.info.lastActivityAt = Date.now();
    this.appendEvent(t, { kind: 'status', status, detail, ts: Date.now() });
    this.emitInfo(t);
  }

  private emitInfo(t: ThreadRecord): void {
    // Info changes (status, title, modes, config) are the meta snapshot's
    // refresh signal — bounded per turn, unlike per-event activity.
    this.persistence.queueMetaWrite(t.info.threadId, this.buildMeta(t));
    for (const sink of t.subscribers) {
      try {
        sink({ op: 'info', info: { ...t.info } });
      } catch {
        // Dropped with the socket.
      }
    }
  }

  private buildMeta(t: ThreadRecord): PersistedThreadMeta {
    return {
      version: 1,
      info: { ...t.info },
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

  /** Resolve any parked runtime-consent prompts as `closed` during teardown. */
  private failPendingRuntimeConsent(t: ThreadRecord): void {
    for (const pending of t.pendingRuntimeConsent.values()) {
      clearTimeout(pending.timer);
      pending.resolve('closed');
    }
    t.pendingRuntimeConsent.clear();
  }

  private setPresence(t: ThreadRecord, mode: 'idle' | 'writing', currentDoc?: string): void {
    const broadcaster = this.opts.agentPresenceBroadcaster;
    if (broadcaster === undefined || broadcaster === null) return;
    try {
      const icon = iconFromClientName(t.info.agent.id);
      const color = AGENT_ICON_COLORS[icon] ?? colorFromSeed(t.agentSessionId);
      broadcaster.setPresence(toBroadcasterKey(t.agentSessionId), {
        displayName: t.info.agent.name,
        icon,
        color,
        currentDoc: currentDoc ?? t.docName ?? AGENT_THREAD_SENTINEL_DOC,
        mode,
        ts: Date.now(),
      });
    } catch (err) {
      this.opts.log.warn({ err }, '[acp-threads] presence update failed');
    }
  }

  private reapIdleThreads(): void {
    const now = Date.now();
    const cutoff = now - this.idleReapMs;
    for (const t of this.threads.values()) {
      // Archived threads hold no process and no memory window — nothing to reap.
      if (t.info.archived === true) continue;
      if (t.subscribers.size === 0 && !t.turnActive && t.info.lastActivityAt < cutoff) {
        this.opts.log.info({ threadId: t.info.threadId }, '[acp-threads] reaping idle thread');
        // A failed reap must not become an unhandled rejection from inside the
        // interval callback — log it and let the next sweep retry.
        this.closeThread(t.info.threadId).catch((err: unknown) => {
          this.opts.log.error({ err, threadId: t.info.threadId }, '[acp-threads] reap failed');
        });
        continue;
      }
      // Unwatched-turn backstop (see DEFAULT_UNWATCHED_TURN_* above).
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

/**
 * Confine a requested path to the content directory. Resolves the deepest
 * existing ancestor through `realpath` so a symlink inside the tree cannot
 * point reads/writes outside it (mirrors the file-watcher's symlink-escape
 * policy), and maps in-scope `.md`/`.mdx` paths to their extension-less
 * docName — rejecting reserved namespaces and filter-excluded paths (those
 * come back `docName: null` and take the plain-disk-IO path).
 *
 * Exported for unit testing; the thread manager is its only prod caller.
 */
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
  // Walk up to the deepest existing ancestor; realpath that, re-append the
  // (not-yet-existing) suffix.
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

/**
 * Build the in-memory record for a persisted thread found at boot. Always
 * archived (any live status in the meta means the server died mid-thread);
 * the event log stays on disk until first subscribe/resume (`logResolved:
 * false` defers the line count, since a crash can leave the meta's `lastSeq`
 * stale).
 */
function rehydratedRecord(meta: PersistedThreadMeta): ThreadRecord {
  const status = meta.info.status === 'error' ? 'error' : 'exited';
  return {
    info: { ...meta.info, status, archived: true },
    docName: meta.docName,
    agentRef: meta.agentRef,
    cwd: meta.cwd,
    child: null,
    conn: null,
    sessionId: meta.sessionId,
    agentSessionId: `acp-${meta.info.threadId}`,
    events: [],
    baseSeq: meta.info.lastSeq + 1,
    logResolved: false,
    logResolution: null,
    midTurnOnDisk: false,
    resumeInFlight: false,
    suppressUpdates: false,
    lastSuppressedAt: 0,
    subscribers: new Set(),
    pendingPermissions: new Map(),
    pendingRuntimeConsent: new Map(),
    stderrTail: [],
    terminals: null,
    turnActive: false,
    cancelRequested: false,
    unwatchedSince: null,
    unwatchedCancelSent: false,
    pendingBroadcast: [],
    pendingBroadcastFromSeq: 0,
    flushTimer: null,
    closed: false,
    // An archived thread on disk carries a transcript, so a resume-then-close
    // without a fresh prompt must archive again, never discard. Treat every
    // rehydrated record as having received a message.
    hadUserMessage: true,
  };
}

/** Error detail shown when a runtime download is declined or times out. */
function declinedRuntimeHint(runtimeKind: ManagedRuntimeKind): string {
  const d = describeRuntime(runtimeKind);
  const installUrl =
    runtimeKind === 'node'
      ? 'https://nodejs.org'
      : 'https://docs.astral.sh/uv/getting-started/installation/';
  return `This agent needs \`${d.provides}\`, which isn't installed. OK can download a private copy of ${d.displayName} for you, or install ${d.displayName} yourself (${installUrl}) and it'll be used automatically.`;
}

function describeAgentError(err: unknown): string {
  if (err instanceof Error) {
    const data = (err as { data?: unknown }).data;
    if (data !== undefined && data !== null) {
      try {
        return `${err.message} (${JSON.stringify(data).slice(0, 300)})`;
      } catch {
        return err.message;
      }
    }
    return err.message;
  }
  return String(err);
}
