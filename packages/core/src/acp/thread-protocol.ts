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
   * disk (`.ok/local/threads/`). Archived threads are listed, viewable via
   * `subscribe` (replayed from disk), resumable via `resume`, and deletable
   * via `delete`. Optional on the wire for version skew — servers always set
   * it; clients treat absence as `false`.
   */
  archived?: boolean;
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
  | { kind: 'status'; status: ThreadStatus; detail?: string; ts: number }
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
    }
  | { op: 'subscribe'; threadId: string; sinceSeq?: number }
  | { op: 'unsubscribe'; threadId: string }
  | { op: 'prompt'; threadId: string; reqId: string; content: string }
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
      /** Permanently delete an ARCHIVED thread's transcript (refused live). */
      op: 'delete';
      threadId: string;
    }
  | { op: 'list' };

/** Server → client frames. */
export type ThreadServerFrame =
  | { op: 'created'; reqId: string; info: ThreadInfo }
  | { op: 'resumed'; reqId: string; info: ThreadInfo }
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
  'permission_response',
  'runtime_consent_response',
  'cancel',
  'set_mode',
  'set_config_option',
  'close',
  'rename',
  'resume',
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
      return frame as unknown as ThreadClientFrame;
    }
    case 'subscribe':
      if (!str('threadId')) return null;
      if (frame.sinceSeq !== undefined && typeof frame.sinceSeq !== 'number') return null;
      return frame as unknown as ThreadClientFrame;
    case 'prompt':
      if (!str('threadId') || !str('reqId') || typeof frame.content !== 'string') return null;
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
