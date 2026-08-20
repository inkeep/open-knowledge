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
import { toBroadcasterKey } from '../agent-id.ts';
import type { AgentPresenceBroadcaster } from '../agent-presence.ts';
import {
  type AgentSessionManager,
  agentWriteLossDetect,
  applyAgentMarkdownWrite,
  snapshotBlocks,
} from '../agent-sessions.ts';
import { isConfigDoc, isSystemDoc } from '../cc1-broadcast.ts';
import type { PinoLogger } from '../logger.ts';
import { MCP_HOSTED_AGENT_HEADER } from '../mcp/agent-identity.ts';
import { RUNTIME_VERSION } from '../version-constants.ts';
import { buildPromptBlocks } from './attachment-blocks.ts';
import { boundSessionUpdateForLog, coalesceChunkInto } from './event-log-bounds.ts';
import {
  AgentLaunchError,
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
/** Prompts allowed to wait behind the active turn before `prompt` rejects. */
export const MAX_QUEUED_PROMPTS = 20;
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
/**
 * How long a parked steer waits for the agent to honor the cancel before it
 * gives up on jumping the line. ACP has no steering primitive — `session/cancel`
 * is a request, and an agent that ignores it would otherwise leave the
 * correction parked forever. On expiry it demotes to the front of the queue,
 * which is honest about what actually happens next.
 */
const DEFAULT_STEER_STALL_MS = 10_000;
/**
 * Ceiling on the ACP `authenticate` round trip. The call is unbounded by
 * protocol and an agent-driven sign-in usually detours through a browser —
 * an abandoned OAuth tab would otherwise leave the request pending forever,
 * and with it the latch that keeps the thread from taking prompts.
 */
const DEFAULT_AUTHENTICATE_TIMEOUT_MS = 5 * 60 * 1000;
const STDERR_TAIL_LINES = 40;
/**
 * How much of an agent's sign-in chatter the prompt will show. A device-code
 * flow spends two lines (the code, the URL); the cap is what keeps a chatty
 * agent from turning the prompt into a log view.
 */
const SIGN_IN_OUTPUT_LINES = 6;
/**
 * `session/load` replays history BEFORE its response resolves per protocol,
 * but at least one adapter (Gemini) fires the replay as a floating promise
 * that can straggle past the response. Before opening the first post-resume
 * turn, wait for a short gap with no replayed updates (bounded so a silent
 * agent can't stall the resume).
 */
const RESUME_REPLAY_QUIESCENCE_MS = 300;
const RESUME_REPLAY_MAX_WAIT_MS = 3_000;
/**
 * JSON-RPC code of the SDK's `RequestError.authRequired()`. The ONLY signal
 * that a `session/new` failure is an auth failure — an agent advertising
 * `authMethods` at initialize is a static fact about the agent, not about
 * this error, and branching on it labeled every Cursor/Gemini failure
 * (including their internal -32603s) as "sign in first".
 */
const AUTH_REQUIRED_CODE = -32000;

/**
 * Environment note prepended (on the wire only — the transcript echoes the
 * user's text) to the first NON-COMMAND prompt of every NEW agent session.
 * Agents assume they run inside their own terminal app and confidently
 * recommend host features that don't exist here (Claude suggesting `/tasks`,
 * `Ctrl+O`). Telling the agent where it actually runs reduces those bad
 * recommendations — it cannot eliminate them (steering a model, not
 * sandboxing it). A prompt opening with `/` defers the note (ACP command
 * dispatch is prefix-based; prepending would break the invocation), and
 * resumed sessions are skipped: their first turn already carried it.
 */
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

/** The bounded `authenticate` round trip ran out of time. Internal marker. */
class AuthenticateTimeoutError extends Error {
  constructor() {
    super('authenticate timed out');
    this.name = 'AuthenticateTimeoutError';
  }
}

/**
 * A Stop landed while the async prompt-block build was still in flight, so
 * we never sent `session/prompt`. Thrown from the build-then-dispatch chain
 * so the existing catch (which honors `cancelRequested`) handles cleanup.
 */
class PromptCancelledBeforeDispatchError extends Error {
  constructor() {
    super('prompt build cancelled before dispatch');
    this.name = 'PromptCancelledBeforeDispatchError';
  }
}

/** A retry took the thread over mid-sign-in; the sign-in stands down silently. */
function threadRestartedDuringSignIn(): ThreadOpError {
  return new ThreadOpError('not-ready', 'the thread was restarted during the sign-in');
}

type Subscriber = (frame: ThreadServerFrame) => void;

interface ThreadRecord {
  info: ThreadInfo;
  /** Extension-less doc the thread was launched from (context only). */
  docName?: string;
  /** Agent reference used to launch — and re-launch on resume. */
  agentRef: { source: 'registry' | 'custom'; id: string };
  /**
   * The remembered settings the create frame carried. Every path that opens a
   * session for this thread AFTER the first attempt (retry, post-`authenticate`
   * re-open) replays them, so a recovered session lands on the user's chosen
   * model/mode exactly like a first launch. Not persisted: a resumed session
   * already carries the settings it was opened with.
   */
  launchSettings?: { config?: Record<string, string | boolean>; modeId?: string };
  /** Session cwd — agents key their session stores by it; resume passes it back verbatim. */
  cwd: string;
  child: ChildProcess | null;
  conn: ClientConnection | null;
  /**
   * The live connection's `initialize` response. Kept because a thread parked
   * in `auth_required` re-opens its session on the SAME connection after
   * `authenticate`, and that needs the capabilities (MCP transport) and the
   * advertised auth methods again. Never persisted — it describes one
   * process, and dies with it.
   */
  lastInit: InitializeResponse | null;
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
  /**
   * An `authenticate` round trip is open. Deliberately NOT `resumeInFlight`:
   * that latch also gates `retryThread`, and retry is the one operation that
   * must still work while a sign-in the user walked away from is parked.
   */
  authInFlight: boolean;
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
      resolve: (decision: 'granted' | 'declined' | 'timeout' | 'closed') => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >;
  stderrTail: string[];
  /**
   * Stderr written while an `authenticate` is in flight, or null outside one.
   * The sign-in prose an agent emits here (a device code, the URL to confirm it
   * against) is the only place that information exists — ACP has no session yet,
   * so the agent has no channel but its own stderr.
   */
  authStderr: string[] | null;
  /** ACP terminals this thread's agent asked OK to run; per-spawn, killed with the thread. */
  terminals: AcpTerminalSet | null;
  turnActive: boolean;
  /** A user cancel is in flight for the current turn — a prompt-request
   *  rejection then reads as "cancelled", not an agent error (agents SHOULD
   *  resolve with stopReason 'cancelled', but some abort the request). */
  cancelRequested: boolean;
  /** Countdown on a parked `info.steer` — fires only if the agent never stops. */
  steerStallTimer: ReturnType<typeof setTimeout> | null;
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
  /**
   * The next dispatched prompt is the first of a NEW agent session and must
   * carry {@link ACP_ENVIRONMENT_NOTE} on the wire. Set when `session/new`
   * succeeds, consumed by the first dispatch, never set on resume/load — a
   * resumed session's first turn already carried the note.
   */
  envNotePending: boolean;
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
  /**
   * Machine-global OK dir (`~/.ok`) where thread transcripts persist under
   * `threads/`, shared across projects and cwd-scoped by `contentDir`. `null`
   * keeps transcripts in the per-project `localDir/threads` (tests). Required
   * so a new construction site can't silently forget where threads live —
   * `null` is the explicit opt-out.
   */
  globalDir: string | null;
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
   * cache root and the download `fetch` so a test can drive the
   * consent/download flow without touching the real `~/.ok` or the network.
   * Unset in production (defaults resolve to `~/.ok/runtimes` + global `fetch`).
   */
  runtimeInstall?: {
    root?: string;
    fetchImpl?: typeof fetch;
  };
  /**
   * The user's login-shell PATH, consulted only after a PATH-resolved command
   * fails preflight and before any managed-runtime download is offered (see
   * `login-shell-path.ts`). Resolves null when there is no answer. Injected by
   * tests so the fallback's effect on a launch can be driven without spawning
   * the developer's own shell; production defaults to the real one-shot probe.
   */
  resolveLoginShellPath?: () => Promise<string | null>;
  log: PinoLogger;
  maxThreads?: number;
  idleReapMs?: number;
  /** How long a parked steer waits for the cancel to land before demoting to the queue. */
  steerStallMs?: number;
  /** Ceiling on one ACP `authenticate` round trip before the sign-in gives up. */
  authenticateTimeoutMs?: number;
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
  /**
   * Interpreters that answered their liveness and compatibility probes cleanly,
   * keyed by command + PATH — see
   * {@link AcpThreadManager.ensureInterpreterRuns}.
   * Healthy verdicts only, so a repaired Node is picked up without a restart;
   * `retryThread` clears it alongside the login-shell memo so the user's retry
   * re-checks an interpreter that broke after it was cached.
   */
  private readonly healthyInterpreters = new Set<string>();
  private destroyed = false;
  private initialized = false;

  constructor(opts: AcpThreadManagerOptions) {
    this.opts = opts;
    // Looked up per call rather than captured: `retryThread` drops the
    // process-wide memo so a binary installed since the failure is seen, and a
    // captured provider would keep answering from the pre-install capture.
    this.resolveLoginShellPath =
      opts.resolveLoginShellPath ?? (() => getSharedLoginShellPathProvider(opts.log)());
    this.maxThreads = opts.maxThreads ?? MAX_ACP_THREADS;
    this.idleReapMs = opts.idleReapMs ?? DEFAULT_IDLE_REAP_MS;
    this.steerStallMs = opts.steerStallMs ?? DEFAULT_STEER_STALL_MS;
    this.authenticateTimeoutMs = opts.authenticateTimeoutMs ?? DEFAULT_AUTHENTICATE_TIMEOUT_MS;
    this.unwatchedTurnCancelMs = opts.unwatchedTurnCancelMs ?? DEFAULT_UNWATCHED_TURN_CANCEL_MS;
    this.unwatchedTurnKillMs = opts.unwatchedTurnKillMs ?? DEFAULT_UNWATCHED_TURN_KILL_MS;
    this.persistence = new ThreadPersistenceStore({
      // Global dir → transcripts under `~/.ok/threads`, cwd-scoped, with the
      // per-project `localDir/threads` as a read-only legacy fallback. No
      // global dir → single per-project dir (unchanged behavior).
      primaryDir: opts.globalDir ?? opts.localDir,
      legacyDir: opts.globalDir !== null ? opts.localDir : null,
      cwd: opts.globalDir !== null ? opts.contentDir : null,
      log: opts.log,
    });
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
    // Warm the login-shell PATH capture off the launch path — every launch
    // merges its answer into the spawn env, and the probe costs a shell
    // startup (bounded, but seconds on a heavy profile).
    void this.resolveLoginShellPath().catch(() => {
      // No verdict is a normal outcome; the launch chain asks again.
    });
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
    /**
     * Attachment parts for the launch prompt. Rides `sendPrompt` alongside
     * the text — server converts each to the ACP content block the agent
     * advertised support for; drops with a log warning otherwise.
     */
    attachments?: readonly AttachmentPart[];
    docName?: string;
    titleHint?: string;
    /**
     * Remembered settings to apply before turn 1: `config` (model, thought
     * level, and any mode advertised as a config option) and `modeId` (the
     * legacy mode surface). Validated against the live session before applying.
     */
    settings?: { config?: Record<string, string | boolean>; modeId?: string };
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
      stderrTail: [],
      authStderr: null,
      terminals: null,
      turnActive: false,
      cancelRequested: false,
      steerStallTimer: null,
      // Born unwatched — the creating socket subscribes right after `created`.
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

    // Ensure the launch command exists AND can actually run. If the
    // interpreter (npx/uvx) is missing, or present but unable to start, offer
    // to download a managed runtime (consent-gated) and rewrite the launch to
    // use it; otherwise this throws an actionable install hint rather than
    // letting the failure surface as an opaque async `spawn ENOENT` or a
    // handshake that never completes.
    const launchable = await this.ensureLaunchable(record, launch);
    if (launchable === null) return null;
    launch = launchable;
    if (record.closed) return null;

    // Resolved before the spawn because `terminal/create` answers the agent
    // synchronously — the set needs the value in hand at construction.
    const loginShellPath = await this.resolveLoginShellPath().catch(() => null);
    if (record.closed) return null;

    // Fresh per spawn: a resume/retry respawns the agent, and terminals from
    // the previous process are dead by construction (disposed on its exit).
    // Built BEFORE the child handlers so the exit handler can dispose THIS
    // spawn's set: a fast retry replaces `record.terminals` while the old
    // child is still dying, and a handler reading the field would then dispose
    // the new agent's live terminals on the old agent's exit.
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
          // Live, not batched with the next status: a device code is only
          // useful while the browser is still asking the user to confirm it.
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
      // Commands the agent asked OK to run die with the agent — nothing
      // should keep executing for a conversation that can no longer see it.
      terminals.disposeAll().catch((err: unknown) => {
        this.opts.log.warn(
          { err, threadId: record.info.threadId },
          '[acp-threads] terminal cleanup on agent exit failed',
        );
      });
      if (record.closed || record.info.archived === true) return;
      // A thread already in 'error' reported its failure (with the stderr
      // tail attached) — the process dying afterwards, whether by itself or
      // via the failed-startup teardown, is that failure's echo, not news.
      // The prompts parked on the dead process are still owed an answer,
      // though: without this an agent that died holding a permission request
      // leaves it hanging until the 10-minute timeout.
      if (record.info.status === 'error') {
        this.failPendingPermissions(record);
        return;
      }
      const tail = record.stderrTail.slice(-10).join('\n');
      // An exit reaching here is unexpected — the closed / archived / already-
      // error cases returned above — so it is the kind of thing an operator
      // reading a bug report needs, and `exited` alone doesn't reach the log
      // the way a failure status does.
      this.opts.log.warn(
        {
          threadId: record.info.threadId,
          agentId: record.info.agent.id,
          code,
          signal,
          // The shared helper, like every other failure path: the status
          // detail is trimmed to 10 lines for the reader, but the log wants
          // the whole tail an operator is going to grep.
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
    // Captured wherever the handshake runs (create, resume, retry). The
    // post-authenticate retry never re-initializes — `authenticateThread`
    // reopens the session on this same connection, inheriting this capture.
    // `{}` — not absence — is the "baseline content only" answer: the wire
    // contract distinguishes "agent said no" from "handshake hasn't
    // resolved yet".
    record.info.promptCapabilities = init.agentCapabilities?.promptCapabilities ?? {};
    this.emitInfo(record);
    return { conn, init, launch };
  }

  /**
   * Make `launch` spawnable. Preflight it; on a command the inherited PATH
   * can't resolve, try the login shell's PATH; then — for npx/uvx only — check
   * that the interpreter we settled on can actually run, and route a missing OR
   * broken one to a managed runtime (already-installed → persisted-consent →
   * interactive consent → download). Returns null only when the thread closed
   * mid-flight; throws an actionable {@link AgentLaunchError} on decline /
   * unsupported platform / failed install (callers map it to an error status).
   */
  private async ensureLaunchable(
    record: ThreadRecord,
    launch: ResolvedLaunch,
  ): Promise<ResolvedLaunch | null> {
    let candidate: ResolvedLaunch;
    try {
      await preflightLaunch(launch);
      // Preflight only proves the TOP-LEVEL command resolves. The adapter goes
      // on to spawn the real harness itself (`npx pi-acp` spawns `pi`), and
      // that lookup runs against the env we hand it — so a launch that
      // preflighted still needs the login shell's PATH, not just one that
      // failed. The merge is append-only: it can add resolutions, never
      // redirect a command that already resolved to a different binary.
      candidate = await this.withLoginShellPathIfEligible(launch);
    } catch (err) {
      if (!(err instanceof AgentLaunchError) || err.code !== 'command-not-found') throw err;
      // A terminal would have found it: adopt the login shell's PATH rather
      // than download a runtime (or blame the user) for a tool they have.
      const viaLoginShell = await this.retryWithLoginShellPath(launch);
      if (viaLoginShell === null) return this.fallbackToManagedRuntime(record, launch, err);
      candidate = viaLoginShell;
    }
    if (record.closed) return null;
    return this.ensureInterpreterRuns(record, candidate);
  }

  /**
   * Guard the case preflight structurally cannot see: an npx/uvx interpreter
   * that resolves and carries the execute bit yet dies the moment it runs (see
   * {@link probeInterpreterHealth}). Both `ensureLaunchable` success paths land
   * here — a login-shell-resolved interpreter can be just as broken as an
   * inherited-PATH one.
   *
   * A broken interpreter goes straight to the managed runtime. An incompatible
   * npx runtime gets one narrower retry with the login-shell PATH promoted,
   * because a terminal-visible compatible Node is preferable to a download.
   * Non-interpreter kinds pass through untouched — a binary/custom command has
   * no managed fallback, so probing it could only add latency and a failure
   * mode with no remedy.
   */
  private async ensureInterpreterRuns(
    record: ThreadRecord,
    launch: ResolvedLaunch,
  ): Promise<ResolvedLaunch | null> {
    if (launch.kind !== 'npx' && launch.kind !== 'uvx') return launch;
    const failure = await this.probeInterpreterOnce(launch);
    if (record.closed) return null;
    if (failure === null) return launch;

    // A compatible Node in the user's terminal should win over a stale Node
    // inherited by the GUI process. This is deliberately narrower than the
    // normal PATH merge: only a proven incompatibility authorizes redirecting
    // an already-resolved interpreter.
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
          // The managed runtime below is the remaining compatible candidate.
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
    // Also the message a decline lands on: the stock decline hint says the
    // interpreter "isn't installed", which is the one thing we just proved
    // wrong — it is installed, it just can't run.
    return this.fallbackToManagedRuntime(record, launch, cause, cause);
  }

  /**
   * Route an npx/uvx interpreter that is missing, broken, or incompatible to the managed
   * runtime, returning the rewritten launch. Returns null only when the thread
   * closed mid-flight; rethrows `cause` when this launch kind or platform has
   * no managed fallback, so the actionable hint reaches the user instead of a
   * generic failure. `declineCause`, when given, replaces the generic
   * "isn't installed" message the user would otherwise get for declining.
   */
  private async fallbackToManagedRuntime(
    record: ThreadRecord,
    launch: ResolvedLaunch,
    cause: AgentLaunchError,
    declineCause?: AgentLaunchError,
  ): Promise<ResolvedLaunch | null> {
    // Only npx/uvx have a managed fallback — a binary/custom command doesn't.
    if (launch.kind !== 'npx' && launch.kind !== 'uvx') throw cause;
    const runtimeKind = runtimeForInterpreter(launch.kind);
    // No download target for this platform → keep the actionable hint.
    if (!runtimeDownloadSupported(runtimeKind)) throw cause;
    const runtime = await this.provideManagedRuntime(
      record,
      runtimeKind,
      // The broken-interpreter path is the one that supplies its own decline
      // message, and it is exactly the path whose offer needs the other copy.
      declineCause === undefined ? 'missing' : 'broken',
    ).catch((err: unknown) => {
      // `command-not-found` out of the runtime provider is the decline hint
      // (an install failure carries `install-failed`), so this swap can only
      // ever replace that one message.
      if (declineCause !== undefined && err instanceof AgentLaunchError) {
        throw err.code === 'command-not-found' ? declineCause : err;
      }
      throw err;
    });
    if (runtime === null) return null; // closed mid-flight
    const rewritten = rewriteLaunchToManagedRuntime(launch, runtime);
    // The managed launcher must itself be executable before we spawn it.
    await preflightLaunch(rewritten);
    // And it must actually RUN. `findManagedRuntime`'s already-installed fast
    // path admits a runtime on the same exists-plus-execute-bit evidence
    // preflight uses, so one left damaged by an interrupted extraction or an
    // earlier layout sails through — and spawning it puts the user back on the
    // opaque "connection closed" with nothing left to try.
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

  /**
   * Replace a damaged copy of OK's own runtime: discard it, offer a fresh
   * download, and probe once more. This copy is OK's, not the user's, so the
   * remedy is ours to carry out rather than a `rm -rf` instruction to follow.
   *
   * One attempt, structurally — this is the only caller of the quarantine and
   * it never re-enters itself, so a runtime that arrives broken twice reports
   * instead of looping. A later launch may try again, which is fine: every
   * download is gated on the prompt, so nothing refetches behind the user.
   */
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
    // A failed quarantine leaves the damaged tree exactly where the install
    // fast path will find it, so re-downloading would hand the same copy back
    // and the retry's failure would name the wrong cause.
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
    if (fresh === null) return null; // closed mid-flight
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

  /**
   * Interpreter liveness plus npx Node compatibility, memoized per command
   * and PATH. Healthy verdicts only: a failing probe
   * is the slow path anyway, and re-running it lets a user who repairs their
   * Node mid-session out of the managed runtime without restarting the server.
   */
  private async probeInterpreterOnce(
    launch: ResolvedLaunch,
  ): Promise<InterpreterProbeFailure | null> {
    // JSON-encoded rather than concatenated: a command or PATH holding the
    // delimiter would otherwise let two launches share a verdict.
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

  /**
   * Second chance for a command the inherited PATH couldn't resolve: append
   * the login shell's PATH and preflight again. Returns the rewritten launch
   * on success, or null when the fallback doesn't apply (path-qualified
   * command, caller-supplied PATH), has nothing to add, or still can't find
   * the command — in which case the caller carries on to the managed runtime.
   */
  private async retryWithLoginShellPath(launch: ResolvedLaunch): Promise<ResolvedLaunch | null> {
    const retry = await this.withLoginShellPathIfEligible(launch);
    if (envPath(retry.env) === envPath(launch.env)) return null;
    try {
      await preflightLaunch(retry);
    } catch (err) {
      // Only a launchability verdict means "keep going to the managed runtime".
      // Anything else is a bug in the preflight itself and must stay visible.
      if (!(err instanceof AgentLaunchError)) throw err;
      // The user has a shell PATH and it still doesn't hold this command — the
      // download offer that follows is the right outcome, but an operator
      // reading the log should see that the second chance was taken and spent.
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

  /**
   * Append the login shell's PATH to a launch's env, or return it untouched
   * when the fallback doesn't apply: a manifest/custom-agent PATH overlay is a
   * spawn-env contract that wins verbatim, and a path-qualified command names
   * its own location, so neither is ours to extend. A probe with no verdict
   * (Windows, no `$SHELL`, a hung profile) also changes nothing.
   */
  private async withLoginShellPathIfEligible(launch: ResolvedLaunch): Promise<ResolvedLaunch> {
    if (launch.pathFromOverlay || isPathQualified(launch.cmd)) return launch;
    const loginShellPath = await this.resolveLoginShellPath().catch(() => null);
    if (loginShellPath === null) return launch;
    return withLoginShellPath(launch, loginShellPath);
  }

  /**
   * Promote the login-shell PATH only after the inherited Node was proven
   * incompatible. Manifest PATH overlays and path-qualified launchers remain
   * authoritative and are never reordered.
   */
  private async withPreferredLoginShellPathIfEligible(
    launch: ResolvedLaunch,
  ): Promise<ResolvedLaunch> {
    if (launch.pathFromOverlay || isPathQualified(launch.cmd)) return launch;
    const loginShellPath = await this.resolveLoginShellPath().catch(() => null);
    if (loginShellPath === null) return launch;
    return withPreferredLoginShellPath(launch, loginShellPath);
  }

  /**
   * Return a managed runtime for `runtimeKind`, downloading it if the user
   * consents. Null means the thread closed while we waited; a throw means the
   * user declined (or the install failed) and the launch can't proceed.
   */
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

  /**
   * Emit a `runtime_consent_request` (retained + replayed like a permission
   * prompt) and park until the user answers via a `runtime_consent_response`
   * frame, the request times out, or the thread closes.
   */
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
      }, RUNTIME_CONSENT_TIMEOUT_MS);
      timer.unref?.();
      record.pendingRuntimeConsent.set(requestId, { resolve: resolvePromise, timer });
    });
  }

  /** Answer a parked runtime-consent prompt from the client. */
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
      // The env marker the stdio branch uses cannot travel over HTTP, so the
      // hosted-agent fact rides a header instead. It has to be per-connection:
      // this same server also answers external clients that legitimately want
      // a navigable URL, so the signal cannot live on the server process.
      mcpServers.push({
        type: 'http',
        name: 'open-knowledge',
        url: `${serverUrl}/mcp`,
        headers: [{ name: MCP_HOSTED_AGENT_HEADER, value: '1' }],
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
          // Carry the hosted-agent marker explicitly rather than relying on
          // the agent to pass its own env through to the MCP servers it
          // spawns. On this branch we name the command, so we can make it
          // deterministic; on the skip branch above the harness spawns its
          // own entry and the marker has to arrive by inheritance from
          // `withHostedAgentMarker` at the agent spawn.
          env: [{ name: OK_HOSTED_AGENT_ENV, value: '1' }],
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
    params: {
      agent: { source: 'registry' | 'custom'; id: string };
      prompt?: string;
      attachments?: readonly AttachmentPart[];
      settings?: { config?: Record<string, string | boolean>; modeId?: string };
    },
    custom: CustomAgentEntry | null,
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
      // Awaited, not fire-and-forget: a retry issued while the old process is
      // still inside its kill grace would find `child` already nulled and
      // no-op its own teardown, leaving two agents alive for one thread.
      await this.teardownFailedAgent(record);
      return;
    }
    if (handshake === null) return;
    const { conn, init, launch } = handshake;

    if ((await this.openSession(record, conn, init, params.settings)) !== true) return;
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

    // Same gate resumeThread now uses: attachment-only creates count as
    // content ("attachments alone ARE the message"). Not currently reachable
    // from any in-tree call site (all `create` frames carry text today), but
    // the wire accepts create.attachments — a version-skewed client would
    // otherwise silently lose them.
    const hasContent =
      (params.prompt !== undefined && params.prompt !== '') ||
      (params.attachments !== undefined && params.attachments.length > 0);
    if (hasContent) {
      this.sendPrompt(record.info.threadId, params.prompt ?? '', params.attachments);
    }
  }

  /**
   * Open the agent session on an already-initialized connection: `session/new`,
   * the remembered launch settings, then `ready`. Shared by the first start
   * and by the post-`authenticate` second attempt, which re-runs exactly this
   * sequence on the connection it already holds.
   *
   * Outcomes are reported as status events rather than thrown; the boolean
   * says only whether the thread reached `ready` (false also covers a thread
   * closed mid-flight).
   *
   * `onAuthRequired: 'report'` hands the auth-required case back to the caller
   * without parking the thread on it, so a caller that has a better answer than
   * "ask the user again" can take it before the user ever sees a prompt.
   */
  private async openSession(
    record: ThreadRecord,
    conn: ClientConnection,
    init: InitializeResponse,
    settings?: { config?: Record<string, string | boolean>; modeId?: string },
    onAuthRequired: 'park' | 'report' = 'park',
  ): Promise<boolean | 'auth-required'> {
    // A fresh session invalidates whatever a previous one advertised (retry
    // and post-authenticate reopen reach here with a dead session's list) —
    // back to "not yet known" until this session's update arrives.
    record.info.availableCommands = null;
    const mcpServers = await this.buildMcpServers(record, init);
    try {
      const session = await conn.agent.request(acpMethods.agent.session.new, {
        cwd: record.cwd,
        mcpServers,
      });
      record.sessionId = session.sessionId;
      // A brand-new session: its first prompt carries the environment note.
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
        // The child stays alive on purpose: the connection is initialized and
        // can take `authenticate` + a session/new retry without a respawn.
      } else {
        this.emitStatus(record, 'error', `session setup failed: ${agentErrorMessage(err)}`, {
          reason: 'session-setup',
          agentMessage: agentErrorMessage(err),
          machineDetail: joinMachineDetail(agentErrorData(err), stderrTailDetail(record)),
        });
        // A session that never opened leaves nothing for the process to do —
        // without this it idles until the reaper, holding a live-thread slot.
        // Awaited so a retry can't spawn a second agent alongside this one
        // while it is still inside its kill grace.
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
      // After config: a model→option cascade may reshape the mode surface, so
      // validate the remembered mode against the settled session state.
      await this.applyInitialMode(record, conn, settings.modeId);
      if (record.closed) return false;
    }

    this.emitStatus(record, 'ready');
    return true;
  }

  /**
   * Resume an archived thread: respawn its agent and reconnect the stored
   * ACP session. Preference order `session/resume` (no history replay — the
   * retained transcript is already the source of truth) over `session/load`
   * (protocol-mandated full replay, suppressed as duplicates), else fail
   * with `resume-unsupported`. Unlike `createThread`, resolves only once the
   * thread is ready (or rejects) — status events stream progress meanwhile.
   */
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
      // The pre-archive command list described a session that no longer
      // exists — back to "not yet known" until the respawned agent advertises
      // (there is no resume-response field for commands, unlike modes).
      t.info.availableCommands = null;
      t.stderrTail = [];
      if (t.midTurnOnDisk) {
        // The persisted log ended inside a turn (crash mid-stream) — close
        // it so the folded transcript doesn't read as still-running.
        t.midTurnOnDisk = false;
        this.appendEvent(t, { kind: 'turn_ended', stopReason: 'cancelled', ts: Date.now() });
      }
      // Attachment-only prompts (image drop with no text) count as content
      // — the message is the picture. `prompt === '' && attachments.length > 0`
      // is a legitimate send and must ride the same optimistic-echo + later
      // dispatch path a text prompt does. Both-empty stays a no-op resume
      // (Reopen with no send).
      const hasContent =
        (prompt !== undefined && prompt !== '') ||
        (attachments !== undefined && attachments.length > 0);
      if (hasContent) {
        // Optimistic echo: the message lands in the transcript (and every
        // subscriber's view) NOW, not after the multi-second respawn +
        // handshake — otherwise the composer clears and nothing visibly
        // happens until the agent is up. `dispatchPrompt` at the end of the
        // handshake skips its own echo to match. Flushed synchronously so
        // the echo frame always precedes the `resumed` response, not just
        // usually (the coalescing timer could lose to a fast handshake).
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
        // A rejected session/load|resume (unknown or expired sessionId, cwd
        // mismatch) — expected at steady state: agents expire their own
        // session stores (Claude defaults to 30 days).
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

  /**
   * Start a failed thread over in place: same thread, same transcript, a fresh
   * launch. Confined to threads that never opened an agent session — one that
   * did has a live agent, and respawning under it would strand a process the
   * user can still see the output of.
   *
   * Retry is also the moment a stale environment answer stops being free: the
   * user reads "install Node", installs it, and comes back. So the login-shell
   * PATH memo is dropped first, and the agent manifest is re-resolved rather
   * than reused. Dropping that memo is process-global and deliberate: every
   * other thread and probe pays one fresh login-shell startup afterwards,
   * which is the right trade for the retry seeing what the user just installed.
   *
   * Resolves once the thread reaches `ready`; rejects with the failure the
   * retry landed on, so the caller can say why the second attempt failed too.
   */
  async retryThread(threadId: string): Promise<ThreadInfo> {
    if (this.destroyed) throw new ThreadOpError('capacity', 'server is shutting down');
    const t = this.mustGet(threadId);
    if (t.info.archived === true) {
      throw new ThreadOpError('not-ready', 'the thread is archived — resume it instead');
    }
    // `authInFlight` is a retryable state of its own: a sign-in the user
    // abandoned in a browser tab sits in `authenticating` until it times out,
    // and retry is the only way out of it. Breaking that latch is safe —
    // closing the connection
    // rejects the parked request, and `authenticateThread` stands down when it
    // sees the connection it captured is no longer the record's.
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
      // Before anything is torn down: an unknown agent (or an unreachable
      // registry) must reject the retry outright rather than leave the thread
      // half-dismantled.
      const { info: agentInfo, custom } = await this.resolveAgentInfo(t.agentRef);
      // `auth_required` keeps its child alive on purpose (the connection can
      // take an `authenticate` without a respawn) — a retry replaces it.
      await this.teardownFailedAgent(t);
      t.info.agent = agentInfo;
      t.stderrTail = [];
      t.cancelRequested = false;
      t.turnActive = false;
      this.emitStatus(t, 'installing');
      try {
        await this.startThread(t, { agent: t.agentRef, settings: t.launchSettings }, custom);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        this.emitStatus(t, 'error', detail, { reason: 'connect', agentMessage: detail });
        throw new ThreadOpError('spawn-failed', detail);
      }
      if (t.closed) throw new ThreadOpError('not-ready', 'thread closed during retry');
      // `startThread` reports every outcome as a status event rather than a
      // throw, so the settled status is what says whether this worked.
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

  /**
   * Complete an advertised sign-in on a thread parked in `auth_required`, then
   * re-open the session on the SAME connection. The child was kept alive for
   * exactly this: an initialized connection takes `authenticate` plus a second
   * `session/new` without a respawn, so signing in costs the user nothing but
   * the round trip.
   *
   * Resolves once the thread is ready; rejects with whatever the sign-in — or
   * the session that followed it — failed on. A thread whose process is gone
   * has nothing to authenticate against and is sent to Retry instead.
   */
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
    // Opened before the request so nothing the agent prints about the sign-in
    // is missed, and held open across the session re-open below: that call can
    // fail for auth reasons too, and its prompt wants the same lines.
    t.authStderr = [];
    t.info.signInOutput = undefined;
    try {
      this.emitStatus(t, 'authenticating');
      try {
        await this.requestAuthenticate(conn, methodId);
      } catch (err) {
        // A retry that ran while this sign-in was parked closed the connection
        // (which is what rejected the request) and now owns the thread — its
        // status is the live one, so this path must say nothing at all.
        if (t.conn !== conn) throw threadRestartedDuringSignIn();
        const timedOut = err instanceof AuthenticateTimeoutError;
        const message = timedOut
          ? `the sign-in didn't complete in time — try again`
          : agentErrorMessage(err);
        // Back to where the user was, with the methods still offered — a
        // rejected (or abandoned) sign-in is a retryable answer, not a dead
        // thread.
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
      // Same session-open sequence the launch runs, on the same connection —
      // any failure but auth tears the process down here, exactly as at launch.
      // The create-time settings ride along so a session recovered through a
      // sign-in opens on the same model/mode a first launch would have.
      const opened = await this.openSession(t, conn, init, t.launchSettings, 'report');
      if (opened === 'auth-required') {
        // The sign-in succeeded and the agent STILL won't open a session: it
        // read its credentials at startup and this process predates them. A
        // fresh one picks them up, which is why Retry has always fixed this —
        // so take that step instead of handing the user back a prompt they
        // already answered.
        this.opts.log.info(
          { threadId, agentId: t.info.agent.id, methodId },
          '[acp-threads] signed in but session still refused — relaunching the agent',
        );
        this.closeSignInCapture(t);
        try {
          return await this.retryThread(threadId);
        } catch (err) {
          // `retryThread` can reject BEFORE it emits any status of its own —
          // `resolveAgentInfo` rejects on an unknown agent or an unreachable
          // registry, both ahead of its first `emitStatus`. Leaving
          // `authenticating` standing there wedges the thread for good: the
          // retry guard admits only `error` / `auth_required`, so every later
          // Retry would be refused and the pane would sit on the sign-in
          // spinner. Park it back where the user can act.
          // Read back through `getInfo`: this function's entry guard narrowed
          // `t.info.status` to `auth_required`, and TS cannot see that
          // `emitStatus` has moved it since.
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

  /**
   * One `authenticate` round trip, bounded. ACP puts no ceiling on it and an
   * agent-driven sign-in usually detours through the browser, so an abandoned
   * flow would otherwise hold the request — and the thread — open forever.
   */
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

  sendPrompt(threadId: string, content: string, attachments?: readonly AttachmentPart[]): void {
    const t = this.mustGet(threadId);
    if (t.info.archived === true) {
      throw new ThreadOpError('not-ready', 'the thread is archived — resume it first');
    }
    if (t.resumeInFlight) {
      // Mid-resume the connection exists before the session is reconnected —
      // a prompt slipping in here would race the session/resume|load request.
      throw new ThreadOpError('not-ready', 'the thread is still resuming');
    }
    if (t.authInFlight) {
      throw new ThreadOpError('not-ready', 'the thread is still signing in');
    }
    if (t.sessionId === null || t.conn === null) {
      throw new ThreadOpError('not-ready', 'thread has no live agent session');
    }
    if (t.turnActive) {
      // Queue behind the active turn instead of rejecting; the turn-end
      // handler in dispatchPrompt drains FIFO. Queue state is ephemeral
      // (memory-only): cancel, agent error/exit, and archive all drop it.
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

  /**
   * Stop the running turn and send `content` as the next one — "steer now".
   *
   * ACP has no mid-turn steering primitive: `session/cancel` is the only
   * sanctioned control, and it is a request the agent may take its time
   * over (or ignore). So the correction parks on `info.steer` and rides the
   * turn-end continuation the cancel produces, ahead of anything queued.
   * If the agent never stops, {@link demoteStalledSteer} converts it into an
   * ordinary queued message rather than leaving it stranded.
   */
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
      // Nothing to steer away from — a correction with no run to correct is
      // just a message.
      this.dispatchPrompt(t, content, attachments, { echo: true });
      return;
    }
    // Latest correction wins: a second steer replaces the parked one (and its
    // countdown) rather than lining up behind it.
    this.clearSteer(t);
    const steer: SteerMessage = { content, ts: Date.now() };
    if (attachments !== undefined && attachments.length > 0) steer.attachments = attachments;
    t.info.steer = steer;
    t.info.lastActivityAt = Date.now();
    this.emitInfo(t);
    const timer = setTimeout(() => this.demoteStalledSteer(t), this.steerStallMs);
    timer.unref?.();
    t.steerStallTimer = timer;
    // The queue survives a steer: those messages were always meant for after
    // this turn, and the steer only claims the slot in front of them.
    this.cancelTurn(t, { clearQueue: false });
  }

  /**
   * The cancel went unanswered for {@link steerStallMs}. Demote the parked
   * correction to the FRONT of the queue: it still goes first, but the user
   * now sees it as a queued row that says when it sends, instead of a promise
   * of an interruption that never came.
   */
  private demoteStalledSteer(t: ThreadRecord): void {
    t.steerStallTimer = null;
    const steer = t.info.steer;
    if (steer === undefined || t.closed || !t.turnActive) return;
    t.info.steer = undefined;
    // Deliberately allowed to exceed MAX_QUEUED_PROMPTS by one. That cap gates
    // NEW sends; dropping a correction the user already committed to (or
    // evicting someone else's queued message to make room) is the worse trade.
    // Preserve steer.attachments — the user attached files to the correction,
    // and a demotion that dropped them would send a different message than
    // the one they typed. Optional so the wire shape matches other queued
    // messages that ride without attachments.
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

  /** Drop any parked steer along with its stall countdown. Broadcast is the
   *  caller's — most call sites are already emitting for another reason. */
  private clearSteer(t: ThreadRecord): void {
    if (t.steerStallTimer !== null) {
      clearTimeout(t.steerStallTimer);
      t.steerStallTimer = null;
    }
    t.info.steer = undefined;
  }

  /** Pop the parked steer, or null. Broadcast rides the dispatch that follows. */
  private takeSteer(t: ThreadRecord): SteerMessage | null {
    const steer = t.info.steer;
    if (steer === undefined) return null;
    this.clearSteer(t);
    return steer;
  }

  /** Replace a queued message's content in place, releasing any hold — a save
   *  IS the resubmit. `false` when the id is unknown: the entry raced its own
   *  dispatch (or a cancel), so the transcript already shows what ran. */
  editQueued(threadId: string, id: string, content: string): boolean {
    const t = this.mustGet(threadId);
    const queue = t.info.queue ?? [];
    if (!queue.some((m) => m.id === id)) return false;
    t.info.queue = queue.map((m) => (m.id === id ? { ...m, content, held: false } : m));
    this.emitInfo(t);
    this.drainIfIdle(t);
    return true;
  }

  /** Park a queued message so the drain skips it (`held`), or release it back
   *  into line. Unknown id: no-op returning `false`. */
  holdQueued(threadId: string, id: string, held: boolean): boolean {
    const t = this.mustGet(threadId);
    const queue = t.info.queue ?? [];
    if (!queue.some((m) => m.id === id)) return false;
    t.info.queue = queue.map((m) => (m.id === id ? { ...m, held } : m));
    this.emitInfo(t);
    if (!held) this.drainIfIdle(t);
    return true;
  }

  /** Remove a queued message before it dispatches. Unknown id: `false`. */
  removeQueued(threadId: string, id: string): boolean {
    const t = this.mustGet(threadId);
    const queue = t.info.queue ?? [];
    const next = queue.filter((m) => m.id !== id);
    if (next.length === queue.length) return false;
    t.info.queue = next.length > 0 ? next : undefined;
    this.emitInfo(t);
    return true;
  }

  /**
   * Dispatch the next releasable entry when no turn is running. The normal
   * drain point is the turn-end continuation; an entry that becomes
   * dispatchable AFTER the turn ended (a hold released, an edit saved) has no
   * such continuation left to ride and would otherwise wait forever.
   */
  private drainIfIdle(t: ThreadRecord): void {
    if (t.turnActive || t.closed || t.resumeInFlight) return;
    if (t.info.archived === true || t.sessionId === null || t.conn === null) return;
    const next = this.takeNextQueued(t);
    if (next === null) return;
    this.dispatchPrompt(t, next.content, next.attachments, { echo: true });
  }

  /** Pop the next dispatchable queued prompt, or null. Held entries are
   *  skipped in place — they keep their position for when they're released.
   *  Broadcast rides the dispatch that follows (its status flip emits the
   *  refreshed info snapshot). */
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

  /** Adopt-title + append the `user_message` transcript event for a prompt. */
  private echoUserMessage(
    t: ThreadRecord,
    content: string,
    attachments?: readonly AttachmentPart[],
  ): void {
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
    const event: ThreadEvent = { kind: 'user_message', content, ts: Date.now() };
    if (attachments !== undefined && attachments.length > 0) event.attachments = attachments;
    this.appendEvent(t, event);
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
    // Wire-only injection: the transcript (echo above) keeps the user's text;
    // the agent additionally receives the environment note ahead of the first
    // prompt of a new session. After the echo, so title derivation and the
    // `user_message` event never see the note. A prompt that OPENS with `/`
    // is skipped — ACP command dispatch is prefix-based (adapters gate on the
    // first text block starting with `/`), so prepending anything would turn
    // a command invocation into prose; the note stays pending and rides the
    // next non-command prompt instead.
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
    // Build the ACP prompt payload. Attachment conversion (fs reads,
    // capability gating, base64 encoding) is async; the outbound ACP
    // request has to wait for it, but the turn-started event has already
    // fired so the user sees the run as engaged.
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
        // Surface each drop in the transcript so the user learns WHY an
        // attachment they meant to send went missing (path escape, stat
        // failure, missing capability). The server-only log is fine for
        // post-mortem but invisible in the moment. Uses `agent_stderr`
        // per the `attachment-blocks.ts` contract — soft, non-fatal,
        // transcript-visible, the same surface the agent's own stderr rides.
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
      // A Stop that lands while we're building the payload (fs realpath +
      // stat per file/folder attachment) races the outbound send. Without
      // this guard the cancel notification would fire against a session
      // that hasn't received session/prompt yet, and the prompt would then
      // arrive and run to completion — the exact turn the user cancelled.
      // Throwing routes cleanup through the existing catch, which honors
      // `cancelRequested` and emits `turn_ended cancelled`.
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
        // Deliver the steer, then drain the queue FIFO — skip the 'ready' blip
        // so the status history reads running → running, matching what the user
        // sees. Guarded on a live connection: an agent that died as the turn
        // settled already dropped both via its terminal status.
        if (t.sessionId !== null && t.conn !== null) {
          // The steer goes first by construction — the user stopped THIS run
          // for it, so it cannot wait behind messages queued before it.
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
        // Some agents answer a cancel by rejecting the prompt request rather
        // than resolving it 'cancelled'. That is still the turn ending, so the
        // steer is still owed — whatever the rejection turns out to mean.
        if (t.sessionId !== null && t.conn !== null) {
          const steer = this.takeSteer(t);
          if (steer !== null) {
            this.dispatchPrompt(t, steer.content, steer.attachments, { echo: true });
            return;
          }
        }
        if (t.cancelRequested) {
          // The user asked for this — an aborted request is a completed
          // cancel, not an agent failure.
          this.emitStatus(t, 'ready');
          // Last, so the 'running' a dispatched prompt emits lands after this
          // 'ready' rather than before it: a steer that stall-demoted to the
          // front of the queue is waiting on this very turn ending, and the
          // rejection path has no other drain.
          this.drainIfIdle(t);
          return;
        }
        if (isAuthRequiredError(err)) {
          // Credentials expired (or were revoked) mid-conversation — the agent
          // rejected `session/prompt` with the same AUTH_REQUIRED code
          // `openSession` handles at startup. Route through the sign-in surface
          // so the user can reauth and retry, mirroring that path: the initial
          // `authMethods` from the still-live connection's `initialize` become
          // the buttons the client renders. Without this branch the failure
          // lands as `reason: 'prompt'`, which the transcript renders as the
          // opaque "Your message didn't reach X" card with no reauth affordance.
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

  /**
   * Send the ACP cancel for the running turn. `clearQueue` is the whole
   * difference between Stop and a steer: Stop means "stop the plan", so
   * everything waiting goes with the turn; a steer only replaces what runs
   * next, so the queue keeps its place behind the correction.
   */
  private cancelTurn(t: ThreadRecord, opts: { clearQueue: boolean }): void {
    if (opts.clearQueue && (t.info.queue !== undefined || t.info.steer !== undefined)) {
      // Before the conn guard, so a cancel racing agent death still clears.
      // The app folds both back into the composer, so the words survive.
      t.info.queue = undefined;
      this.clearSteer(t);
      this.emitInfo(t);
    }
    if (t.conn === null || t.sessionId === null) return;
    if (t.turnActive) t.cancelRequested = true;
    // Per ACP, a cancelled turn's pending permission requests resolve as
    // 'cancelled' client-side — and a turn blocked ON a permission prompt
    // only actually stops when we do (the agent is awaiting our response).
    this.failPendingPermissions(t);
    this.restoreRunningAfterPermission(t);
    // Caught, not `void`ed: the notification's write can still be in flight
    // when the connection closes (a thread closed right after a Stop), and an
    // unhandled rejection there would take the server process with it. A
    // cancel that lost its connection has already had its effect.
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

  /**
   * Apply the user's remembered per-agent config options to a fresh session
   * BEFORE the first prompt, so turn 1 runs on their chosen model. Applied
   * model-category first and awaited one at a time: a `set_config_option`
   * response is the agent's authoritative post-change state (picking a model
   * can reshape the thought-level choices), so each step re-validates against
   * the reshaped options. Unknown / deprecated / already-current values are
   * skipped; a rejected set is logged and does not block the rest. Best-effort
   * by design — the turn proceeds on the agent's defaults for anything that
   * couldn't be applied.
   */
  private async applyInitialConfig(
    record: ThreadRecord,
    conn: NonNullable<ThreadRecord['conn']>,
    config: Record<string, string | boolean>,
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
      if (option === undefined) continue; // agent no longer offers this option
      if (option.currentValue === value) continue; // already the agent's default
      if (!initialConfigValueValid(option, value)) continue; // stored value gone (e.g. retired model)
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
    // The thread still opens on the agent's defaults for anything that couldn't
    // be applied (best-effort). One rolled-up warn makes "my remembered settings
    // didn't stick" diagnosable from a bundle without correlating per-id lines.
    if (rejected.length > 0) {
      this.opts.log.warn(
        { threadId: record.info.threadId, rejectedConfigIds: rejected },
        '[acp-threads] some remembered config options could not be applied to the new session',
      );
    }
    if (applied) this.emitInfo(record);
  }

  /**
   * Apply the user's remembered mode to a fresh session BEFORE the first
   * prompt. Best-effort: the mode must still be advertised
   * by the settled session; an unknown or already-current mode is skipped, and
   * a rejected set is logged and does not block the turn. Handles both mode
   * surfaces — the legacy `SessionModeState` (`session/set_mode`) and the
   * generalized mode-category config option (`session/set_config_option`).
   */
  private async applyInitialMode(
    record: ThreadRecord,
    conn: NonNullable<ThreadRecord['conn']>,
    modeId: string,
  ): Promise<void> {
    const sessionId = record.sessionId;
    if (sessionId === null) return;
    const modes = record.info.modes;
    if (modes != null) {
      // Legacy SessionModeState path (Claude's permission modes).
      if (modes.availableModes.some((m) => m.id === modeId)) {
        if (modes.currentModeId === modeId) return; // already the session default
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
    // Generalized mode-category config option (agents that expose mode there).
    const option = (record.info.configOptions ?? []).find(
      (o) => o.category === 'mode' && initialConfigValueValid(o, modeId),
    );
    if (option === undefined || option.currentValue === modeId) return;
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
    this.clearSteer(t);
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
    t.lastInit = null;
    await t.terminals?.disposeAll();
    t.terminals = null;
    this.opts.agentPresenceBroadcaster?.clearPresence(toBroadcasterKey(t.agentSessionId));
    await this.opts.sessionManager.closeAllForAgent(t.agentSessionId).catch((err) => {
      this.opts.log.warn({ err, threadId }, '[acp-threads] session cleanup failed');
    });
    // Never-used thread (no user message ever recorded): discard it rather than
    // archive. The agent is dead above; drop the record and its (possibly
    // partial) persisted log so a spawned-but-untouched agent leaves no history.
    // EXCEPT a thread that failed to start: its transcript is the only record
    // of what went wrong (a startup failure disables the composer, so such a
    // thread can never receive a user message — discarding meant every failed
    // launch erased its own evidence the moment the tab closed).
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
    if (update.sessionUpdate === 'available_commands_update') {
      record.info.availableCommands = update.availableCommands;
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
        applyAgentMarkdownWrite(
          session.dc.document,
          content,
          'replace',
          embedResolver,
          undefined,
          agentWriteLossDetect(session),
        );
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
      this.setPresence(record, target.docName);
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

  private emitStatus(
    t: ThreadRecord,
    status: ThreadStatus,
    detail?: string,
    failure?: ThreadFailureDetail,
  ): void {
    // A terminal status is the single choke point where waiting prompts die —
    // whatever path got here (agent exit, connection loss, prompt failure,
    // archive), messages must not fire into a dead agent. The parked steer
    // goes with the queue: it exists to jump a run that no longer exists.
    if (status === 'exited' || status === 'error') {
      t.info.queue = undefined;
      this.clearSteer(t);
    }
    t.info.status = status;
    t.info.lastActivityAt = Date.now();
    if (status === 'error' || status === 'auth_required') {
      // Failure statuses reach the server log too — without this line a
      // failed launch left no operator-visible trace anywhere but the
      // (user-deletable) thread transcript.
      this.opts.log.warn(
        {
          threadId: t.info.threadId,
          agentId: t.info.agent.id,
          status,
          detail,
          reason: failure?.reason,
          // The agent's own last words. `detail` is the user-facing summary
          // ("initialize failed: ACP connection closed"), which names the
          // symptom; the cause — a dyld abort, a missing API key, a stack
          // trace — only ever appears here.
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

  /**
   * Kill a failed thread's agent process and drop its connection while
   * keeping the record (and its failure status) addressable — the user still
   * needs to read the banner, and close/retry still need the thread.
   */
  private async teardownFailedAgent(t: ThreadRecord): Promise<void> {
    const child = t.child;
    const conn = t.conn;
    // Captured before the field is cleared so a retry that spawns a fresh set
    // in the meantime cannot have it disposed out from under it.
    const terminals = t.terminals;
    t.child = null;
    t.conn = null;
    t.lastInit = null;
    t.terminals = null;
    try {
      conn?.close();
    } catch {
      // Already closed.
    }
    // Before the kill: the agent is going away, and a command it left running
    // would otherwise outlive both it and the thread's ability to show output.
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
    // Info changes (status, title, modes, config) are the meta snapshot's
    // refresh signal — bounded per turn, unlike per-event activity.
    this.persistence.queueMetaWrite(t.info.threadId, this.buildMeta(t));
    this.broadcastInfo(t);
  }

  /**
   * Push an info snapshot to subscribers WITHOUT queueing a meta write. For
   * fields that are transient by contract and arrive at a cadence the meta
   * file must not follow — sign-in output lands per stderr line, where
   * `emitInfo` would mean a write-and-rename each time.
   */
  private broadcastInfo(t: ThreadRecord): void {
    for (const sink of t.subscribers) {
      try {
        sink({ op: 'info', info: { ...t.info } });
      } catch {
        // Dropped with the socket.
      }
    }
  }

  /**
   * End the sign-in's stderr capture and take its output off the screen. Also
   * called before a relaunch: what a fresh process prints is its own startup,
   * and letting it land in this buffer would carry a spent device code and the
   * new child's boot noise into the next prompt's disclosure.
   */
  private closeSignInCapture(t: ThreadRecord): void {
    t.authStderr = null;
    if (t.info.signInOutput !== undefined) {
      t.info.signInOutput = undefined;
      this.broadcastInfo(t);
    }
  }

  private buildMeta(t: ThreadRecord): PersistedThreadMeta {
    // The queue, the parked steer, and the sign-in output are ephemeral by
    // contract — persisting the first two would resurrect ghost prompts into
    // an archived thread after a mid-turn crash, and the third would restore a
    // dead device code onto a thread whose sign-in is long over.
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

  /** Resolve any parked runtime-consent prompts as `closed` during teardown. */
  private failPendingRuntimeConsent(t: ThreadRecord): void {
    for (const pending of t.pendingRuntimeConsent.values()) {
      clearTimeout(pending.timer);
      pending.resolve('closed');
    }
    t.pendingRuntimeConsent.clear();
  }

  /**
   * Publish a presence entry for a doc this thread just wrote through ACP's
   * native `fs/write_text_file`. That is the ONLY publisher here: an agent
   * connected over OK's MCP already advertises its own heartbeated presence,
   * so mirroring the turn lifecycle on top only blipped a second chip in and
   * out of the bar every prompt. Adapters that write through ACP's fs path
   * have no MCP entry standing in for those writes, and follow-the-file reads
   * this one, so it stays.
   */
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
    // `queue`/`steer`/`signInOutput: undefined` belt-and-suspenders: buildMeta
    // never persists any of them, but a meta written by a different build must
    // not resurrect them.
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
    // An archived thread on disk carries a transcript, so a resume-then-close
    // without a fresh prompt must archive again, never discard. Treat every
    // rehydrated record as having received a message.
    hadUserMessage: true,
    envNotePending: false,
  };
}

/** True when `value` is still a selectable value of `option` (booleans always). */
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

/** Error detail shown when a runtime download is declined or times out. */
function declinedRuntimeHint(runtimeKind: ManagedRuntimeKind): string {
  const d = describeRuntime(runtimeKind);
  const installUrl =
    runtimeKind === 'node'
      ? 'https://nodejs.org'
      : 'https://docs.astral.sh/uv/getting-started/installation/';
  return `This agent needs \`${d.provides}\`, which isn't installed. OK can download a private copy of ${d.displayName} for you, or install ${d.displayName} yourself (${installUrl}) and it'll be used automatically.`;
}

/**
 * True when a request failed with an auth-required signal. Two shapes qualify:
 *
 *   1. `code === AUTH_REQUIRED_CODE` (`-32000`) — the ACP standard for
 *      `session/new` refusing to open until sign-in.
 *   2. `data.errorKind === 'authentication_failed'` — the Claude Agent SDK's
 *      shape when its OAuth token can't refresh mid-turn (its `session/prompt`
 *      rejects with `-32603` "Internal error" plus this discriminator in the
 *      data payload, NOT with `-32000`). Recognizing it here is what routes
 *      mid-conversation expiry through the sign-in surface instead of the
 *      opaque "message didn't reach" card.
 *
 * Structural (`code` / `data.errorKind` fields) rather than `instanceof
 * RequestError` so a dual-package SDK instance can't defeat the check.
 */
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

/** The failing side's own human-readable message — never wire payloads. */
function agentErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** JSON-RPC `data` payload, serialized for the disclosure — never headline copy. */
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

/** What the most recent failure status said — the reason a retried op rejects with. */
function lastFailureMessage(t: ThreadRecord): string | undefined {
  for (let i = t.events.length - 1; i >= 0; i -= 1) {
    const event = t.events[i];
    if (event === undefined || event.kind !== 'status') continue;
    if (event.status !== 'error' && event.status !== 'auth_required') continue;
    return event.detail ?? event.failure?.agentMessage;
  }
  return undefined;
}

/**
 * The stderr the agent wrote — its real diagnostic, usually. The whole
 * retained tail, not a slice of it: this feeds the failure disclosure, which
 * exists precisely so the evidence is there when someone goes looking.
 */
function stderrTailDetail(t: ThreadRecord): string | undefined {
  const tail = t.stderrTail.join('\n');
  return tail === '' ? undefined : tail;
}

function joinMachineDetail(...parts: Array<string | undefined>): string | undefined {
  const joined = parts.filter((p): p is string => p !== undefined && p !== '').join('\n');
  return joined === '' ? undefined : joined;
}

/**
 * A sign-in prompt carries the agent's own words about the error plus whatever
 * it wrote to stderr DURING the sign-in — and never the whole tail. Nothing has
 * gone wrong on a thread waiting to authenticate, so the tail is only the
 * startup noise the agent happened to write (npm warnings, boot banners), and
 * attaching it buries the lines that can help. Those lines are worth keeping:
 * a device-code flow prints its code and confirmation URL to stderr, which is
 * the only channel it has before a session exists. Genuine failures keep the
 * whole tail; there it is usually the only evidence.
 */
function authMachineDetail(err: unknown, t: ThreadRecord): string | undefined {
  const duringSignIn = t.authStderr === null ? undefined : t.authStderr.join('\n');
  return joinMachineDetail(agentErrorData(err), duringSignIn);
}

/** Trim the SDK's `AuthMethod[]` to the wire shape the client renders. */
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
        // The SDK's discriminant travels as-is: an absent `type` means the
        // agent handles the sign-in itself, which the client must be able to
        // tell apart from `env_var` / `terminal` methods it can't complete.
        ...(typeof type === 'string' ? { kind: type } : {}),
      },
    ];
  });
}
