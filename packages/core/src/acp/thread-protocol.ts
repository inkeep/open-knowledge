/**
 * Wire protocol for the `/collab/thread` WebSocket — the transport between
 * the server-hosted ACP thread manager and the app's thread UI.
 *
 * Shared between `packages/server` (producer) and `packages/app` (consumer);
 * lives in core so both sides compile against one contract. ACP payloads
 * (`SessionUpdate`, permission options, content blocks) pass through as the
 * SDK's own generated types — imported TYPE-ONLY so no SDK runtime code
 * reaches the browser bundle.
 *
 * Delivery contract: every thread event carries a per-thread monotonically
 * increasing `seq`. The server retains a bounded in-memory event log per
 * thread; `subscribe` with `sinceSeq` replays the retained tail and then
 * streams live. A reconnecting client re-subscribes with its last-seen seq —
 * the same recovery shape the CRDT layer's "durable truth + live push"
 * channels use, without a second HTTP surface.
 */

import type {
  ContentBlock,
  PermissionOption,
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
  StopReason,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';

/**
 * Lifecycle of a server-hosted agent thread. `awaiting_permission` is
 * `running` refined: the turn is parked on a permission prompt, so the tab
 * strip can show "blocked on you" instead of a generic spinner. Terminal
 * failures always win over it — a dead turn's stale prompt must never read
 * as still inviting approval.
 */
export type ThreadStatus =
  | 'installing'
  | 'spawning'
  | 'ready'
  | 'auth_required'
  | 'running'
  | 'awaiting_permission'
  | 'exited'
  | 'error';

/** Runtimes OK can download on demand to launch an agent (see `managed-runtime.ts`). */
export type ManagedRuntimeKind = 'node' | 'uv';

/**
 * One auth method the agent advertised at `initialize`, trimmed to what the
 * client renders — and to the `id` that `authenticate` targets. Mirrors the
 * SDK's `AuthMethod` union minus per-variant launch mechanics.
 */
export interface ThreadAuthMethod {
  id: string;
  name: string;
  description?: string;
  /**
   * The SDK's `AuthMethod` discriminant, forwarded verbatim (`env_var`,
   * `terminal`; absent means the agent drives its own sign-in). It decides
   * whether OK can complete the sign-in over the protocol or the user has to
   * go to their own terminal/environment first. Optional on the wire: events
   * persisted before this field existed replay without it.
   */
  kind?: string;
}

/**
 * Structured detail for a failure-shaped `status` event. The server has no
 * i18n layer, so it must not compose user-facing prose from wire payloads;
 * it labels the failure and forwards the agent's own message instead. The
 * app renders translatable copy from `reason`, quotes `agentMessage`, and
 * keeps `machineDetail` behind a disclosure — never in headline copy.
 */
export interface ThreadFailureDetail {
  /** Which step failed — the app maps this to translatable copy. */
  reason: 'auth-required' | 'connect' | 'session-setup' | 'prompt';
  /** The failing side's own human-readable message, when one exists. */
  agentMessage?: string;
  /** Wire-level payload (JSON-RPC `data`, stderr tail) — disclosure-only. */
  machineDetail?: string;
  /** Advertised auth methods (present only on `auth-required`). */
  authMethods?: ThreadAuthMethod[];
}

/** Agent identity as the catalog + thread UI render it. */
export interface ThreadAgentInfo {
  /** Registry manifest id (or custom-agent id). */
  id: string;
  /** Display name ("Claude Agent", "Gemini CLI"). */
  name: string;
  /** SVG icon URL from the registry manifest, when available. */
  iconUrl?: string;
  /** 'registry' manifest or user-configured 'custom' entry. */
  source: 'registry' | 'custom';
  /**
   * Manifest version of the build OK launched (registry agents only). The
   * user's own terminal may hold a different one, so the thread header names
   * which build is answering.
   */
  version?: string;
}

/**
 * A prompt waiting behind the active turn. Queue state is ephemeral —
 * in-memory only, dropped on cancel/error/exit and never persisted — so it
 * rides the `ThreadInfo` snapshot (meta channel), NOT the event log: a
 * replayed transcript must not resurrect ghost queue entries.
 */
export interface QueuedMessage {
  /** Server-assigned id — the handle `queue_edit` / `queue_remove` target. */
  id: string;
  content: string;
  ts: number;
  /**
   * Parked: the drain skips this entry and moves to the next one, but the
   * entry keeps its place in the queue. An open edit holds its row, so a turn
   * that ends mid-edit dispatches the rest of the queue rather than the stale
   * text the user is halfway through replacing.
   */
  held?: boolean;
}

/**
 * A correction parked while the run it corrects is being stopped for it
 * ("Steer now"). Not a queue entry: it rides the turn-end continuation the
 * cancel produces, so it lands as the very next turn while the queue keeps
 * its place behind it. Ephemeral exactly like {@link QueuedMessage} — never
 * persisted, dropped on cancel/error/exit.
 */
export interface SteerMessage {
  content: string;
  ts: number;
}

/** Snapshot metadata for one thread (tab strip + thread header). */
export interface ThreadInfo {
  threadId: string;
  agent: ThreadAgentInfo;
  title: string;
  status: ThreadStatus;
  createdAt: number;
  lastActivityAt: number;
  /** Present once the agent advertised modes (Ask / Architect / Code …). */
  modes?: SessionModeState | null;
  /**
   * Present once the agent advertised session config options — the
   * generalized selector surface (model picker, thought level, …). The
   * array is the agent's authoritative current state; each
   * `config_option_update` / set response replaces it wholesale.
   */
  configOptions?: SessionConfigOption[] | null;
  /** Last event seq in the server's retained log (replay upper bound). */
  lastSeq: number;
  /**
   * The thread's agent process is gone but its transcript is retained on
   * disk (`~/.ok/threads/`, or the pre-move per-project `.ok/local/threads/`
   * for threads created before that move). Archived threads are listed, viewable via
   * `subscribe` (replayed from disk), resumable via `resume`, and deletable
   * via `delete`. Optional on the wire for version skew — servers always set
   * it; clients treat absence as `false`.
   */
  archived?: boolean;
  /**
   * Prompts queued behind the active turn, FIFO. Absent (or empty) when
   * nothing is waiting. Live-thread-only and never persisted: the server
   * drops the queue on cancel, agent error/exit, and archive.
   */
  queue?: QueuedMessage[];
  /**
   * The correction waiting for the current run to stop (see
   * {@link SteerMessage}). At most one — a second steer replaces it, because
   * the latest correction is the one the user means. Live-thread-only and
   * never persisted.
   */
  steer?: SteerMessage;
}

/** One entry in a thread's event log. */
export type ThreadEvent =
  | { kind: 'user_message'; content: string; ts: number }
  | { kind: 'session_update'; update: SessionUpdate; ts: number }
  | {
      kind: 'permission_request';
      requestId: string;
      toolCall: ToolCallUpdate;
      options: PermissionOption[];
      ts: number;
    }
  | {
      kind: 'permission_resolved';
      requestId: string;
      /** Chosen optionId, or null when cancelled/auto-rejected. */
      optionId: string | null;
      /** True when policy resolved it without asking the user. */
      auto: boolean;
      ts: number;
    }
  | { kind: 'turn_started'; ts: number }
  | { kind: 'turn_ended'; stopReason: StopReason; ts: number }
  | {
      kind: 'status';
      status: ThreadStatus;
      detail?: string;
      /** Structured failure detail; `detail` stays the legacy/fallback string. */
      failure?: ThreadFailureDetail;
      ts: number;
    }
  | { kind: 'title_changed'; title: string; ts: number }
  | { kind: 'agent_stderr'; line: string; ts: number }
  | {
      /**
       * The agent's launch needs an interpreter (npx/uvx) the machine lacks;
       * OK offers to download a private, pinned copy. The thread is parked
       * until the user answers with a `runtime_consent_response` frame (or the
       * request times out). Retained + replayed like `permission_request`, so
       * a client that subscribes after it was emitted still sees the prompt.
       */
      kind: 'runtime_consent_request';
      requestId: string;
      runtime: ManagedRuntimeKind;
      /** Human runtime name — "Node.js" / "uv". */
      displayName: string;
      /** The interpreter it unlocks — "npx" / "uvx". */
      provides: string;
      version: string;
      /** Approximate download size (MB) for the disclosure. */
      approxSizeMB: number;
      /** Download host ("nodejs.org"), so the user sees where bytes come from. */
      sourceHost: string;
      /** The agent whose launch is blocked on this decision. */
      agentName: string;
      ts: number;
    }
  | {
      kind: 'runtime_consent_resolved';
      requestId: string;
      /** `timeout` when nobody answered before the launch gave up. */
      decision: 'granted' | 'declined' | 'timeout';
      ts: number;
    }
  | {
      /** Download/verify/extract progress while a consented runtime installs. */
      kind: 'runtime_install_progress';
      runtime: ManagedRuntimeKind;
      phase: 'downloading' | 'verifying' | 'extracting';
      receivedBytes?: number;
      totalBytes?: number;
      ts: number;
    }
  | {
      /**
       * The agent ran a command through the ACP terminal surface (OK executes
       * it; the agent embeds the terminal in a tool call by id). Emitted at
       * spawn so the transcript can show the command line even before any
       * output arrives.
       */
      kind: 'terminal_created';
      terminalId: string;
      command: string;
      args: string[];
      ts: number;
    }
  | {
      /** A chunk of combined stdout+stderr from a terminal OK is running. */
      kind: 'terminal_output';
      terminalId: string;
      chunk: string;
      ts: number;
    }
  | {
      /** The terminal's command finished (or was killed). */
      kind: 'terminal_exit';
      terminalId: string;
      /** Process exit code; null when terminated by signal. */
      exitCode: number | null;
      /** Terminating signal; null on a normal exit. */
      signal: string | null;
      ts: number;
    };

/** Client → server frames. */
export type ThreadClientFrame =
  | {
      op: 'create';
      /** Echoed on the matching `created` / `error` response frame. */
      reqId: string;
      agent: { source: 'registry' | 'custom'; id: string };
      /** Optional first prompt, sent as soon as the session is ready. */
      prompt?: string;
      /** Optional doc context: extension-less docName the launch came from. */
      docName?: string;
      /**
       * The user's raw typed text (create brief / instruction), carried
       * separately from `prompt` so the thread title derives from it rather
       * than from the composed launch prompt — which opens with a fixed
       * handoff preamble that would otherwise become every tab's label.
       * Absent for bare launches (no typed text); the server falls back to
       * deriving from `prompt`.
       */
      titleHint?: string;
      /**
       * Remembered per-agent-type settings to apply between `session/new` and
       * the first prompt, so a new thread of the same agent opens on the
       * model / options the user last chose. `config` maps configId → value;
       * the server applies them (model-category first) so option cascades
       * re-validate before turn 1. `modeId` restores a mode on the legacy
       * `SessionModeState` surface (a mode advertised as a config option rides
       * `config` like any other option). The server validates it against the
       * live session's advertised modes; a mode that reads as permissive stays
       * visibly marked in the client while it is in force.
       */
      settings?: { config?: Record<string, string | boolean>; modeId?: string };
    }
  | { op: 'subscribe'; threadId: string; sinceSeq?: number }
  | { op: 'unsubscribe'; threadId: string }
  | { op: 'prompt'; threadId: string; reqId: string; content: string }
  | {
      /**
       * Stop the running turn and send this instead. The correction parks on
       * `ThreadInfo.steer` until the turn actually ends, then dispatches ahead
       * of anything queued. With no turn running it is a plain prompt.
       */
      op: 'steer';
      threadId: string;
      reqId: string;
      content: string;
    }
  | {
      /**
       * Replace a queued message's content in place. Targets an entry of
       * `ThreadInfo.queue` by its server-assigned id; an unknown id is a
       * silent no-op (the entry raced its own dispatch — the transcript
       * already shows the original was sent).
       */
      op: 'queue_edit';
      threadId: string;
      id: string;
      content: string;
      /**
       * When present, the server answers on it either way: `queue_edited` on
       * success, an `error` frame (`not-ready`) when the entry already
       * dispatched — so the client can tell the user their edit never landed.
       * Absent, the edit is fire-and-forget.
       */
      reqId?: string;
    }
  | {
      /**
       * Park a queued message so the drain skips it (`held: true`), or release
       * it back into the drain (`held: false`). Held entries keep their FIFO
       * position. Unknown id: no-op.
       */
      op: 'queue_hold';
      threadId: string;
      id: string;
      held: boolean;
    }
  | {
      /** Remove a queued message before it dispatches. Unknown id: no-op. */
      op: 'queue_remove';
      threadId: string;
      id: string;
    }
  | {
      op: 'permission_response';
      threadId: string;
      requestId: string;
      outcome: { kind: 'selected'; optionId: string } | { kind: 'cancelled' };
    }
  | { op: 'cancel'; threadId: string }
  | {
      /**
       * Answer a `runtime_consent_request`: allow (or refuse) OK to download
       * the managed runtime a blocked launch needs. `remember` persists the
       * decision for future launches on this machine.
       */
      op: 'runtime_consent_response';
      threadId: string;
      requestId: string;
      outcome: { kind: 'granted'; remember?: boolean } | { kind: 'declined'; remember?: boolean };
    }
  | { op: 'set_mode'; threadId: string; modeId: string }
  | {
      op: 'set_config_option';
      threadId: string;
      configId: string;
      /** Select options carry the chosen valueId; boolean options a toggle. */
      value: string | boolean;
    }
  | { op: 'close'; threadId: string }
  | {
      /**
       * Manually retitle a thread (tab rename). Works on live and archived
       * threads; the server clamps the title and confirms via an `info`
       * frame (plus a `title_changed` transcript event).
       */
      op: 'rename';
      threadId: string;
      title: string;
    }
  | {
      /**
       * Resume an archived thread: respawn its agent and continue the same
       * ACP session (`session/resume` preferred, `session/load` fallback).
       * Responds with `resumed` (or an `error` carrying this `reqId`) once
       * the handshake settles; `prompt` is sent as the first turn on success.
       */
      op: 'resume';
      threadId: string;
      reqId: string;
      prompt?: string;
    }
  | {
      /**
       * Start a failed thread over in place: same thread, same transcript, a
       * fresh launch. Refused unless the thread is live, sitting in a failure
       * status, and holds no agent session — a thread that has one has a live
       * agent that a silent respawn would strand. Responds with `retried`, or
       * an `error` frame carrying this `reqId`.
       */
      op: 'retry';
      threadId: string;
      reqId: string;
    }
  | {
      /**
       * Complete an advertised sign-in on a thread parked in `auth_required`:
       * the server sends ACP's `authenticate` on the SAME connection and then
       * re-attempts the session open, so no respawn is involved. `methodId` is
       * one of the `authMethods` the failure notice carried. Responds with
       * `authenticated`, or an `error` frame carrying this `reqId`.
       */
      op: 'authenticate';
      threadId: string;
      reqId: string;
      methodId: string;
    }
  | {
      /** Permanently delete an ARCHIVED thread's transcript (refused live). */
      op: 'delete';
      threadId: string;
    }
  | { op: 'list' };

/** Server → client frames. */
export type ThreadServerFrame =
  | { op: 'created'; reqId: string; info: ThreadInfo }
  | { op: 'resumed'; reqId: string; info: ThreadInfo }
  | { op: 'retried'; reqId: string; info: ThreadInfo }
  | { op: 'authenticated'; reqId: string; info: ThreadInfo }
  | { op: 'subscribed'; threadId: string; fromSeq: number; info: ThreadInfo }
  | { op: 'event'; threadId: string; seq: number; event: ThreadEvent }
  | {
      /**
       * Consecutive events starting at `fromSeq` (`events[i]` has seq
       * `fromSeq + i`). The normal delivery shape: replay arrives in chunks
       * and live events coalesce on a short trailing debounce, so one frame
       * (one JSON parse, one store update, one render) carries a burst
       * instead of one frame per streamed chunk. `event` remains for
       * single-event sends (e.g. the terminal close notice).
       */
      op: 'events';
      threadId: string;
      fromSeq: number;
      events: ThreadEvent[];
    }
  | {
      /**
       * Positive ack for a `queue_edit` that carried a `reqId`. The edit has
       * no state of its own on the wire — the refreshed `info` merely reflects
       * the queue — so without a frame that means "this request applied", a
       * client correlating on `info` settles the edit the moment ANY info for
       * the thread arrives and can never see the refusal that follows.
       */
      op: 'queue_edited';
      reqId: string;
      threadId: string;
    }
  | { op: 'info'; info: ThreadInfo }
  | { op: 'threads'; threads: ThreadInfo[] }
  | {
      op: 'error';
      code: ThreadErrorCode;
      message: string;
      reqId?: string;
      threadId?: string;
    };

export type ThreadErrorCode =
  | 'bad-frame'
  | 'unknown-thread'
  | 'unknown-agent'
  | 'capacity'
  | 'spawn-failed'
  | 'install-failed'
  | 'agent-error'
  | 'not-ready'
  /** The agent advertises neither `session/resume` nor `session/load` (or
   *  rejected the stored sessionId) — the transcript stays archived; the
   *  client offers a fresh thread instead. */
  | 'resume-unsupported'
  | 'internal';

const CLIENT_OPS = new Set([
  'create',
  'subscribe',
  'unsubscribe',
  'prompt',
  'steer',
  'queue_edit',
  'queue_hold',
  'queue_remove',
  'permission_response',
  'runtime_consent_response',
  'cancel',
  'set_mode',
  'set_config_option',
  'close',
  'rename',
  'resume',
  'retry',
  'authenticate',
  'delete',
  'list',
]);

/**
 * Parse a raw WS message into a `ThreadClientFrame`, or `null` when the
 * bytes are not a recognizable frame. Structural (per-op field presence)
 * only — semantic validation (thread existence, status) is the manager's.
 */
export function parseThreadClientFrame(raw: string): ThreadClientFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const frame = value as Record<string, unknown>;
  if (typeof frame.op !== 'string' || !CLIENT_OPS.has(frame.op)) return null;
  const str = (k: string): boolean => typeof frame[k] === 'string' && frame[k] !== '';
  switch (frame.op) {
    case 'create': {
      if (!str('reqId')) return null;
      const agent = frame.agent as Record<string, unknown> | undefined;
      if (
        typeof agent !== 'object' ||
        agent === null ||
        (agent.source !== 'registry' && agent.source !== 'custom') ||
        typeof agent.id !== 'string' ||
        agent.id === ''
      ) {
        return null;
      }
      if (frame.prompt !== undefined && typeof frame.prompt !== 'string') return null;
      if (frame.docName !== undefined && typeof frame.docName !== 'string') return null;
      if (frame.settings !== undefined) {
        const settings = frame.settings as Record<string, unknown> | null;
        if (typeof settings !== 'object' || settings === null) return null;
        if (settings.config !== undefined) {
          const config = settings.config as Record<string, unknown> | null;
          if (typeof config !== 'object' || config === null || Array.isArray(config)) return null;
          for (const v of Object.values(config)) {
            if (typeof v !== 'string' && typeof v !== 'boolean') return null;
          }
        }
        if (settings.modeId !== undefined && typeof settings.modeId !== 'string') return null;
      }
      return frame as unknown as ThreadClientFrame;
    }
    case 'subscribe':
      if (!str('threadId')) return null;
      if (frame.sinceSeq !== undefined && typeof frame.sinceSeq !== 'number') return null;
      return frame as unknown as ThreadClientFrame;
    case 'prompt':
      if (!str('threadId') || !str('reqId') || typeof frame.content !== 'string') return null;
      return frame as unknown as ThreadClientFrame;
    // Unlike `prompt`, empty content is refused: a steer cancels a running
    // turn, and doing that for nothing is a Stop wearing the wrong name.
    case 'steer':
      if (!str('threadId') || !str('reqId') || !str('content')) return null;
      return frame as unknown as ThreadClientFrame;
    case 'queue_edit':
      if (!str('threadId') || !str('id') || !str('content')) return null;
      if (frame.reqId !== undefined && !str('reqId')) return null;
      return frame as unknown as ThreadClientFrame;
    case 'queue_hold':
      if (!str('threadId') || !str('id') || typeof frame.held !== 'boolean') return null;
      return frame as unknown as ThreadClientFrame;
    case 'queue_remove':
      if (!str('threadId') || !str('id')) return null;
      return frame as unknown as ThreadClientFrame;
    case 'permission_response': {
      if (!str('threadId') || !str('requestId')) return null;
      const outcome = frame.outcome as Record<string, unknown> | undefined;
      if (typeof outcome !== 'object' || outcome === null) return null;
      if (outcome.kind === 'selected') {
        if (typeof outcome.optionId !== 'string' || outcome.optionId === '') return null;
      } else if (outcome.kind !== 'cancelled') {
        return null;
      }
      return frame as unknown as ThreadClientFrame;
    }
    case 'runtime_consent_response': {
      if (!str('threadId') || !str('requestId')) return null;
      const outcome = frame.outcome as Record<string, unknown> | undefined;
      if (typeof outcome !== 'object' || outcome === null) return null;
      if (outcome.kind !== 'granted' && outcome.kind !== 'declined') return null;
      if (outcome.remember !== undefined && typeof outcome.remember !== 'boolean') return null;
      return frame as unknown as ThreadClientFrame;
    }
    case 'set_mode':
      if (!str('threadId') || !str('modeId')) return null;
      return frame as unknown as ThreadClientFrame;
    case 'rename':
      if (!str('threadId') || !str('title')) return null;
      return frame as unknown as ThreadClientFrame;
    case 'set_config_option':
      if (!str('threadId') || !str('configId')) return null;
      if (typeof frame.value !== 'string' && typeof frame.value !== 'boolean') return null;
      if (frame.value === '') return null;
      return frame as unknown as ThreadClientFrame;
    case 'resume':
      if (!str('threadId') || !str('reqId')) return null;
      if (frame.prompt !== undefined && typeof frame.prompt !== 'string') return null;
      return frame as unknown as ThreadClientFrame;
    case 'retry':
      if (!str('threadId') || !str('reqId')) return null;
      return frame as unknown as ThreadClientFrame;
    case 'authenticate':
      if (!str('threadId') || !str('reqId') || !str('methodId')) return null;
      return frame as unknown as ThreadClientFrame;
    case 'unsubscribe':
    case 'cancel':
    case 'close':
    case 'delete':
      if (!str('threadId')) return null;
      return frame as unknown as ThreadClientFrame;
    case 'list':
      return frame as unknown as ThreadClientFrame;
    default:
      return null;
  }
}

/** Type-only re-exports the app's renderer needs alongside the frames. */
export type {
  ContentBlock,
  PermissionOption,
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
  StopReason,
  ToolCallUpdate,
};
