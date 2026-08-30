/**
 * Fold a thread's flat `ThreadEvent[]` into the render model the thread view
 * draws: an ordered list of turns and system notices, with streamed message
 * chunks coalesced by `messageId`, tool calls tracked by `toolCallId` through
 * their status transitions, and the latest plan kept as a live checklist.
 *
 * The fold is INCREMENTAL: `ThreadRenderModelBuilder.sync(events)` applies
 * only the events it hasn't seen, so a streaming turn costs O(new events) per
 * update instead of re-folding the whole log — the full re-fold made long
 * transcripts progressively more sluggish (each chunk re-paid every string
 * concat since turn start). Item updates are copy-on-write: an untouched
 * transcript row keeps its object identity across snapshots; only rows that
 * actually changed get new ones.
 *
 * Kept pure (no React) so it is unit-testable and the components stay thin
 * renderers over this model.
 *
 * The two title fallbacks below resolve at fold time rather than at render,
 * because `title` is a plain string the follow-file matcher also reads. The
 * cost is that rows folded before a language switch keep the language they
 * were folded in — a historical transcript row, which the next fold corrects.
 */

import {
  type CodexLegacyAgentIdentity,
  isCodexLegacyWarningUpdate,
} from '@inkeep/open-knowledge-core/acp/codex-legacy-notice';
import type {
  PermissionOption,
  PiBridgeThreadState,
  SessionUpdate,
  ThreadEvent,
  ThreadFailureDetail,
} from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { t } from '@lingui/core/macro';

/**
 * A rendered turn. Discriminated on `role` so the compiler holds the
 * "user turns only" rule the two extra fields carry, rather than a comment:
 * agent text arrives as chunks that coalesce into one bubble, so no single
 * instant describes it, and it never carries attachment parts.
 */
type RenderedMessage =
  | {
      kind: 'message';
      role: 'user';
      text: string;
      messageId: string;
      /** Attachment parts that rode this message on send. Frozen at send time
       *  by the server so a replayed transcript renders exactly what was sent. */
      attachments?: readonly import('@inkeep/open-knowledge-core/acp/thread-protocol').AttachmentPart[];
      /** When the event carrying this message was logged. */
      sentAt?: number;
    }
  | {
      kind: 'message';
      role: 'agent' | 'thought';
      text: string;
      messageId: string;
    };

export interface RenderedToolCall {
  kind: 'tool_call';
  toolCallId: string;
  title: string;
  toolKind: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  /** Diffs the agent attached to this call (path + before/after). */
  diffs: Array<{ path: string; oldText: string | null; newText: string }>;
  /** Terminal ids embedded in the call (live output rendered elsewhere). */
  terminalIds: string[];
  /** Plain text/content result blocks. */
  content: string[];
  /** File locations the agent touched (follow-the-agent). */
  locations: Array<{ path: string; line?: number }>;
  /** The adapter-reported raw tool input (MCP calls carry docName args here). */
  rawInput: unknown;
}

export interface RenderedPermission {
  kind: 'permission';
  requestId: string;
  title: string;
  toolKind: string;
  options: PermissionOption[];
  resolved: { optionId: string | null; auto: boolean } | null;
  /** The tool call this prompt gates. Null if the agent omitted it. */
  toolCallId: string | null;
  /**
   * That tool call is in the transcript, so its row can carry this outcome and
   * the prompt need not restate it as a second card. False keeps the standalone
   * card as the fallback — an outcome must never become unreachable just
   * because the call it gated never showed up.
   */
  mergedIntoToolCall: boolean;
}

interface RenderedNotice {
  kind: 'notice';
  /** The server's legacy headline string — empty for structured failures. */
  text: string;
  tone: 'info' | 'error';
  /**
   * Structured failure the view renders as translated copy plus a disclosure.
   * Null for notices that carry only a server-composed string (older
   * transcripts, and any failure site that hasn't been classified yet).
   */
  failure: ThreadFailureDetail | null;
  /**
   * A later `ready` answered this failure — the launch it complained about
   * eventually worked, so the card no longer describes anything the user can
   * act on. Kept in the log (positions are load-bearing) and skipped by the
   * view.
   */
  superseded?: boolean;
  /**
   * How many identical error events collapsed into this notice. 1 for a
   * single failure; N when the launch retried and every attempt failed with
   * the same `reason` + `agentMessage` + `machineDetail`. See the coalesce
   * block in `applyEvent(status)` for the exact match rule.
   */
  attempts: number;
}

/**
 * Operational status the agent's runtime reported mid-turn — how the session
 * is configured or behaving — as opposed to the answer the agent authored.
 *
 * Deliberately NOT a variant of `RenderedNotice`, which models a thread
 * failure: that shape carries retry, supersession and attempt state, and none
 * of it is answerable on passive guidance. Keeping them apart is what makes a
 * Retry button on this row unrepresentable rather than merely unrendered.
 *
 * `source` and `severity` are single-member unions on purpose. The protocol's
 * own typed notice is not deliverable by any released ACP SDK yet, so its arm
 * gets discriminated in beside this one when it becomes reachable, rather than
 * leaving fields nothing can populate today.
 */
interface RenderedAgentNotice {
  kind: 'agent_notice';
  source: 'codex_legacy';
  severity: 'warning';
  /** The producer's event text, byte for byte. Never rewritten or translated. */
  text: string;
  /**
   * Seq of the retained event this was minted from. Carried because arrival
   * behaviour depends on which side of the replay window an event fell on, and
   * that question is only answerable per event: counting notices cannot
   * separate the tail of a replayed log from a live arrival that landed in the
   * same batch.
   */
  seq: number;
}

/**
 * Live state of one ACP terminal (a command OK ran for the agent), folded
 * from `terminal_*` events. Rendered inside the tool call that embeds the
 * terminal id — terminals are not transcript items of their own.
 */
export interface RenderedTerminal {
  terminalId: string;
  command: string;
  args: string[];
  output: string;
  /** The transcript copy dropped output (display bound), not the command's. */
  truncated: boolean;
  /** null while the command is still running. */
  exit: { exitCode: number | null; signal: string | null } | null;
}

/** Keep at most this much of a terminal's output in the render model (tail wins). */
const TERMINAL_RENDER_CHAR_CAP = 64_000;

interface RenderedRuntimeConsent {
  kind: 'runtime_consent';
  requestId: string;
  runtime: 'node' | 'uv';
  /** "Node.js" / "uv". */
  displayName: string;
  /** The interpreter it unlocks — "npx" / "uvx". */
  provides: string;
  version: string;
  approxSizeMB: number;
  sourceHost: string;
  agentName: string;
  /** Absent on events persisted before the field existed — those were `missing`. */
  reason: 'missing' | 'broken' | 'damaged';
  /** null while awaiting the user's answer. */
  resolved: 'granted' | 'declined' | 'timeout' | null;
  /**
   * Install lifecycle after a grant, driven by the follow-on thread status:
   * `running` while downloading, `done` once the launch proceeds (spawning),
   * `failed` if the launch errored out. Keeps a completed card from showing a
   * stuck spinner on replay.
   */
  install: 'running' | 'done' | 'failed' | null;
  /** Latest download progress once granted (bytes), else null. */
  progress: { receivedBytes: number; totalBytes: number | null } | null;
}

/**
 * Pi's bridge extension for this project, as one transcript row: the consent
 * prompt while it is pending, and its settled outcome afterwards. A status
 * event can arrive with no prompt before it (a file OK won't touch already
 * sits at the managed path), which is why `requestId` is nullable — that row
 * is a limitation notice, not an answered question.
 */
interface RenderedPiBridgePrompt {
  requestId: string;
  agentName: string;
  cwd: string;
  /** Other extensions in that folder the trust grant would also turn on. */
  otherExtensions: readonly string[];
}

interface RenderedPiBridgeOutcome {
  state: PiBridgeThreadState;
  detail: string | null;
}

/**
 * A Pi bridge row is one of two things, tagged so the renderer narrows instead
 * of guarding a state that cannot exist: a row the user was asked about (which
 * may still be awaiting its outcome), or a standing limitation notice, which is
 * an outcome nobody was asked about. `outcome` alone can't carry the tag — a
 * property only discriminates when its type is a union of unit types, and an
 * object-or-null is not.
 */
interface RenderedPiBridgeBase {
  kind: 'pi_bridge';
  bridgePath: string;
  /** null while awaiting the user's answer. */
  decision: 'granted' | 'declined' | 'timeout' | null;
}

type RenderedPiBridge =
  | (RenderedPiBridgeBase & {
      row: 'prompted';
      prompt: RenderedPiBridgePrompt;
      outcome: RenderedPiBridgeOutcome | null;
    })
  | (RenderedPiBridgeBase & { row: 'notice'; prompt: null; outcome: RenderedPiBridgeOutcome });

export type RenderedItem =
  | RenderedMessage
  | RenderedToolCall
  | RenderedPermission
  | RenderedNotice
  | RenderedAgentNotice
  | RenderedRuntimeConsent
  | RenderedPiBridge;

export interface PlanEntry {
  content: string;
  priority?: string;
  status?: string;
}

export interface ThreadRenderModel {
  items: RenderedItem[];
  plan: PlanEntry[];
  /** True while the current prompt turn is streaming. */
  turnActive: boolean;
  /** Context-window fill from the agent's `usage_update` (tokens). */
  tokenUsage: { used?: number; size?: number } | null;
  /** Terminals by id, for tool calls that embed them (`terminalIds`). */
  terminals: Record<string, RenderedTerminal>;
  /**
   * Permission prompts keyed by the tool call they gate, so a call's row can
   * show its own approval instead of a sibling card repeating the tool name.
   * Maintained by the fold rather than derived per render — same reason
   * `terminals` is: a streamed turn re-renders on every chunk.
   */
  permissionsByToolCall: Record<string, RenderedPermission>;
}

function textFromContent(content: unknown): string | null {
  if (typeof content !== 'object' || content === null) return null;
  const c = content as { type?: string; text?: string };
  return c.type === 'text' && typeof c.text === 'string' ? c.text : null;
}

/**
 * Failures a successful launch retires. The startup reasons only: a `prompt`
 * failure happened inside a live session, so a later `ready` says nothing
 * about it and the user still needs to see it.
 */
function isSupersededByReady(failure: ThreadFailureDetail | null): boolean {
  return (
    failure !== null &&
    (failure.reason === 'connect' ||
      failure.reason === 'session-setup' ||
      failure.reason === 'auth-required')
  );
}

export class ThreadRenderModelBuilder {
  /**
   * Which agent is answering. Required rather than optional because one
   * producer's payloads are read differently from every other's, and a
   * defaulted identity would silently fold a thread as "not that producer" —
   * the failure would be an absent notice, which looks exactly like a healthy
   * transcript. Callers with no identity to offer pass null explicitly.
   */
  constructor(private readonly agent: CodexLegacyAgentIdentity | null) {}

  private items: RenderedItem[] = [];
  private plan: PlanEntry[] = [];
  private turnActive = false;
  private tokenUsage: ThreadRenderModel['tokenUsage'] = null;
  private terminals: Record<string, RenderedTerminal> = {};
  /** Item index by toolCallId / permission requestId / `role:messageId`. */
  private toolCallIndex = new Map<string, number>();
  private permissionIndex = new Map<string, number>();
  /** Item index of the permission gating a given toolCallId. */
  private permissionByToolCall = new Map<string, number>();
  private permissionsByToolCall: Record<string, RenderedPermission> = {};
  private messageIndex = new Map<string, number>();
  private runtimeConsentIndex = new Map<string, number>();
  /** Item index of the Pi bridge card by consent requestId. */
  private piBridgeIndex = new Map<string, number>();
  /** Item index of the most recent consent card — progress events target it. */
  private lastConsentIndex: number | null = null;
  private appliedCount = 0;
  private dirty = false;
  private snapshot: ThreadRenderModel = {
    items: [],
    plan: [],
    turnActive: false,
    tokenUsage: null,
    terminals: {},
    permissionsByToolCall: {},
  };

  /**
   * Apply any events beyond what was applied already and return the current
   * model. The snapshot is referentially stable while no new events arrive —
   * safe as a `useSyncExternalStore` getter. A shorter array than previously
   * seen means the log was rebuilt (thread dropped and re-added); the
   * builder starts over.
   */
  sync(events: readonly ThreadEvent[]): ThreadRenderModel {
    if (events.length < this.appliedCount) this.reset();
    for (let i = this.appliedCount; i < events.length; i++) {
      // The array index IS the event's seq. The store keeps that true on the
      // way in — it dedupes an overlapping batch and pads a batch that opens
      // above the tail — so a caller assembling events by hand owes the same
      // alignment.
      this.applyEvent(events[i], i);
    }
    this.appliedCount = events.length;
    if (this.dirty) {
      this.snapshot = {
        items: [...this.items],
        plan: this.plan,
        turnActive: this.turnActive,
        tokenUsage: this.tokenUsage,
        terminals: { ...this.terminals },
        permissionsByToolCall: { ...this.permissionsByToolCall },
      };
      this.dirty = false;
    }
    return this.snapshot;
  }

  private reset(): void {
    this.items = [];
    this.plan = [];
    this.turnActive = false;
    this.tokenUsage = null;
    this.terminals = {};
    this.toolCallIndex = new Map();
    this.permissionIndex = new Map();
    this.permissionByToolCall = new Map();
    this.permissionsByToolCall = {};
    this.messageIndex = new Map();
    this.runtimeConsentIndex = new Map();
    this.piBridgeIndex = new Map();
    this.lastConsentIndex = null;
    this.appliedCount = 0;
    this.dirty = true;
  }

  private applyEvent(event: ThreadEvent, seq: number): void {
    this.dirty = true;
    switch (event.kind) {
      case 'user_message': {
        const message: RenderedMessage = {
          kind: 'message',
          role: 'user',
          text: event.content,
          messageId: `user-${this.items.length}`,
          sentAt: event.ts,
        };
        if (event.attachments !== undefined && event.attachments.length > 0) {
          message.attachments = event.attachments;
        }
        this.items.push(message);
        // A user turn resets streaming message coalescing.
        this.messageIndex.clear();
        break;
      }
      case 'turn_started':
        this.turnActive = true;
        break;
      case 'turn_ended':
        this.turnActive = false;
        this.messageIndex.clear();
        break;
      case 'status':
        // A terminal exit ends any dangling turn. A persisted transcript can
        // end with `turn_started` and no `turn_ended` — the agent process
        // exited before the prompt settled — which would otherwise replay as a
        // perpetual "working" spinner. A later `turn_started` (resume) re-arms.
        if (event.status === 'exited') this.turnActive = false;
        // A granted runtime install resolves when the launch moves on: the
        // agent spawns (done) or the thread errors (failed).
        if (this.lastConsentIndex !== null) {
          const c = this.items[this.lastConsentIndex];
          if (c?.kind === 'runtime_consent' && c.install === 'running') {
            if (
              event.status === 'spawning' ||
              event.status === 'ready' ||
              event.status === 'running'
            ) {
              this.items[this.lastConsentIndex] = { ...c, install: 'done' };
            } else if (event.status === 'error' || event.status === 'exited') {
              this.items[this.lastConsentIndex] = { ...c, install: 'failed' };
            }
          }
        }
        if (event.status === 'ready') {
          // A launch that eventually worked answers every failure it took to
          // get there: those notices were the ways in, and one of them landed.
          // Left standing they pile up at the top of a healthy thread — amber
          // cards about a sign-in the user already completed.
          //
          // Marked, never removed: six index maps hold positions into `items`,
          // so dropping an element would silently retarget every one of them.
          for (let index = 0; index < this.items.length; index += 1) {
            const item = this.items[index];
            if (
              item?.kind === 'notice' &&
              item.superseded !== true &&
              isSupersededByReady(item.failure)
            ) {
              this.items[index] = { ...item, superseded: true };
            }
          }
        }
        if (event.status === 'error' || event.status === 'auth_required') {
          // A structured failure alone is enough: the view composes its own
          // copy from `reason`, so the server no longer has to ship a string.
          if (event.failure !== undefined || (event.detail ?? '') !== '') {
            const next: RenderedNotice = {
              kind: 'notice',
              text: event.detail ?? '',
              tone: event.status === 'error' ? 'error' : 'info',
              failure: event.failure ?? null,
              attempts: 1,
            };
            // Coalesce adjacent identical failures into ONE card whose
            // attempt count grows. The launch's retry loop fires a status
            // event per attempt, and without this the transcript stacked
            // three visually-identical error cards for one bad spawn — the
            // reader had to click through each to find the retry button on
            // the last. Same `reason` + `agentMessage` + `machineDetail` +
            // `tone` + text is our proxy for "the same failure, again"; if
            // any of those differ the failure is genuinely new and gets its
            // own card.
            const last = this.items[this.items.length - 1];
            // A superseded notice was retired by a later `ready`; merging into
            // it would carry `superseded: true` forward via the spread and the
            // live failure would render nowhere (ThreadView filters superseded
            // out entirely). Force a new card in that case.
            if (last?.kind === 'notice' && last.superseded !== true && isSameFailure(last, next)) {
              this.items[this.items.length - 1] = {
                ...last,
                attempts: last.attempts + 1,
              };
            } else {
              this.items.push(next);
            }
          }
        }
        break;
      case 'permission_request': {
        const toolCallId = event.toolCall.toolCallId ?? null;
        const permission: RenderedPermission = {
          kind: 'permission',
          requestId: event.requestId,
          title: event.toolCall.title ?? t`Permission required`,
          toolKind: event.toolCall.kind ?? 'other',
          options: event.options,
          resolved: null,
          toolCallId,
          // The gated call may not have streamed in yet; `tool_call` back-fills
          // this when it lands, so the order of the two events doesn't matter.
          mergedIntoToolCall: toolCallId !== null && this.toolCallIndex.has(toolCallId),
        };
        this.permissionIndex.set(event.requestId, this.items.length);
        if (toolCallId !== null) {
          this.permissionByToolCall.set(toolCallId, this.items.length);
          this.permissionsByToolCall[toolCallId] = permission;
        }
        this.items.push(permission);
        break;
      }
      case 'permission_resolved': {
        const index = this.permissionIndex.get(event.requestId);
        if (index === undefined) break;
        const target = this.items[index];
        if (target.kind !== 'permission') break;
        const resolved: RenderedPermission = {
          ...target,
          resolved: { optionId: event.optionId, auto: event.auto },
        };
        this.items[index] = resolved;
        if (resolved.toolCallId !== null) {
          this.permissionsByToolCall[resolved.toolCallId] = resolved;
        }
        break;
      }
      case 'runtime_consent_request':
        this.runtimeConsentIndex.set(event.requestId, this.items.length);
        this.lastConsentIndex = this.items.length;
        this.items.push({
          kind: 'runtime_consent',
          requestId: event.requestId,
          runtime: event.runtime,
          displayName: event.displayName,
          provides: event.provides,
          version: event.version,
          approxSizeMB: event.approxSizeMB,
          sourceHost: event.sourceHost,
          agentName: event.agentName,
          reason: event.reason ?? 'missing',
          resolved: null,
          install: null,
          progress: null,
        });
        break;
      case 'runtime_consent_resolved': {
        const index = this.runtimeConsentIndex.get(event.requestId);
        if (index === undefined) break;
        const target = this.items[index];
        if (target.kind !== 'runtime_consent') break;
        this.items[index] = {
          ...target,
          resolved: event.decision,
          install: event.decision === 'granted' ? 'running' : null,
        };
        break;
      }
      case 'pi_bridge_consent_request':
        this.piBridgeIndex.set(event.requestId, this.items.length);
        this.items.push({
          kind: 'pi_bridge',
          row: 'prompted',
          prompt: {
            requestId: event.requestId,
            agentName: event.agentName,
            cwd: event.cwd,
            // Persisted events from before this field existed replay without it.
            otherExtensions: event.otherExtensions ?? [],
          },
          bridgePath: event.bridgePath,
          decision: null,
          outcome: null,
        });
        break;
      case 'pi_bridge_consent_resolved': {
        const index = this.piBridgeIndex.get(event.requestId);
        if (index === undefined) break;
        const target = this.items[index];
        if (target.kind !== 'pi_bridge') break;
        this.items[index] = { ...target, decision: event.decision };
        break;
      }
      case 'pi_bridge_status': {
        const outcome = { state: event.state, detail: event.detail ?? null };
        const index =
          event.requestId === undefined ? undefined : this.piBridgeIndex.get(event.requestId);
        const target = index === undefined ? undefined : this.items[index];
        // Fold onto the card that asked, so one row carries question and
        // answer. A status with no card of its own to update stands alone.
        if (index !== undefined && target?.kind === 'pi_bridge') {
          this.items[index] = { ...target, outcome };
          break;
        }
        this.items.push({
          kind: 'pi_bridge',
          row: 'notice',
          prompt: null,
          bridgePath: event.bridgePath,
          decision: null,
          outcome,
        });
        break;
      }
      case 'runtime_install_progress': {
        if (this.lastConsentIndex === null) break;
        const target = this.items[this.lastConsentIndex];
        if (target === undefined || target.kind !== 'runtime_consent') break;
        this.items[this.lastConsentIndex] = {
          ...target,
          progress: {
            receivedBytes: event.receivedBytes ?? 0,
            totalBytes: event.totalBytes ?? null,
          },
        };
        break;
      }
      case 'terminal_created':
        this.terminals[event.terminalId] = {
          terminalId: event.terminalId,
          command: event.command,
          args: event.args,
          output: '',
          truncated: false,
          exit: null,
        };
        break;
      case 'terminal_output': {
        const terminal = this.terminals[event.terminalId];
        if (terminal === undefined) break;
        let output = terminal.output + event.chunk;
        let truncated = terminal.truncated;
        if (output.length > TERMINAL_RENDER_CHAR_CAP) {
          output = output.slice(-TERMINAL_RENDER_CHAR_CAP);
          truncated = true;
        }
        this.terminals[event.terminalId] = { ...terminal, output, truncated };
        break;
      }
      case 'terminal_exit': {
        const terminal = this.terminals[event.terminalId];
        if (terminal === undefined) break;
        this.terminals[event.terminalId] = {
          ...terminal,
          exit: { exitCode: event.exitCode, signal: event.signal },
        };
        break;
      }
      case 'session_update':
        this.applyUpdate(event.update, seq);
        break;
      default:
        break;
    }
  }

  /**
   * Mark the permission gating `toolCallId` as carried by that call's row.
   * No-op when no prompt gated it, or when it is already merged.
   */
  private mergePermissionInto(toolCallId: string): void {
    const index = this.permissionByToolCall.get(toolCallId);
    if (index === undefined) return;
    const target = this.items[index];
    if (target === undefined || target.kind !== 'permission' || target.mergedIntoToolCall) return;
    const merged: RenderedPermission = { ...target, mergedIntoToolCall: true };
    this.items[index] = merged;
    this.permissionsByToolCall[toolCallId] = merged;
  }

  private pushMessageChunk(role: RenderedMessage['role'], messageId: string, text: string): void {
    const key = `${role}:${messageId}`;
    const index = this.messageIndex.get(key);
    // Coalesce streamed chunks only while the message is still the transcript
    // tail. Most adapters send no messageId (everything keys to 'default'),
    // so without the tail check every later chunk glues onto the FIRST
    // bubble and tool calls pile up beneath it — instead of the
    // chronological output → tool call → output the transcript should read
    // as. Anything in between (tool call, permission, notice, user turn)
    // starts a fresh block.
    if (index !== undefined && index === this.items.length - 1) {
      const existing = this.items[index] as RenderedMessage;
      this.items[index] = { ...existing, text: existing.text + text };
      return;
    }
    this.messageIndex.set(key, this.items.length);
    this.items.push({ kind: 'message', role, text, messageId });
  }

  private applyUpdate(update: SessionUpdate, seq: number): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = textFromContent(update.content);
        if (text === null) break;
        // Decided per retained event, before coalescing: once two events have
        // been glued into one bubble the producer's own boundary is gone, and
        // recovering it would mean guessing where the warning ended inside a
        // larger body. All-or-nothing on the whole event, so a near miss keeps
        // its bytes and follows the ordinary path untouched.
        if (isCodexLegacyWarningUpdate(update, this.agent)) {
          this.items.push({
            kind: 'agent_notice',
            source: 'codex_legacy',
            severity: 'warning',
            text,
            seq,
          });
          break;
        }
        this.pushMessageChunk('agent', messageId(update), text);
        break;
      }
      case 'agent_thought_chunk': {
        const text = textFromContent(update.content);
        if (text !== null) this.pushMessageChunk('thought', messageId(update), text);
        break;
      }
      case 'user_message_chunk': {
        const text = textFromContent(update.content);
        if (text !== null) this.pushMessageChunk('user', messageId(update), text);
        break;
      }
      case 'tool_call': {
        const call: RenderedToolCall = {
          kind: 'tool_call',
          toolCallId: update.toolCallId,
          title: update.title ?? t`Tool call`,
          toolKind: update.kind ?? 'other',
          status: (update.status as RenderedToolCall['status']) ?? 'pending',
          diffs: [],
          terminalIds: [],
          content: [],
          locations: normalizeLocations(update.locations),
          rawInput: (update as { rawInput?: unknown }).rawInput,
        };
        mergeToolContent(call, update.content);
        this.toolCallIndex.set(update.toolCallId, this.items.length);
        this.items.push(call);
        // The prompt for this call arrived first (the usual order: the agent
        // asks, then streams the call). Now that the row exists to carry the
        // outcome, fold the standalone card away.
        this.mergePermissionInto(update.toolCallId);
        break;
      }
      case 'tool_call_update': {
        const index = this.toolCallIndex.get(update.toolCallId);
        if (index === undefined) break;
        const existing = this.items[index];
        if (existing.kind !== 'tool_call') break;
        // Copy-on-write, arrays included — the previous snapshot keeps the
        // untouched row while mergeToolContent appends to the copy.
        const call: RenderedToolCall = {
          ...existing,
          diffs: [...existing.diffs],
          terminalIds: [...existing.terminalIds],
          content: [...existing.content],
        };
        if (update.status) call.status = update.status as RenderedToolCall['status'];
        if (update.title) call.title = update.title;
        if (update.locations) call.locations = normalizeLocations(update.locations);
        const rawInput = (update as { rawInput?: unknown }).rawInput;
        if (rawInput !== undefined) call.rawInput = rawInput;
        mergeToolContent(call, update.content);
        this.items[index] = call;
        break;
      }
      case 'plan': {
        const entries = (update as { entries?: unknown }).entries;
        if (Array.isArray(entries)) {
          this.plan = entries
            .map((e) => e as Record<string, unknown>)
            .filter((e) => typeof e.content === 'string')
            .map((e) => ({
              content: e.content as string,
              priority: typeof e.priority === 'string' ? e.priority : undefined,
              status: typeof e.status === 'string' ? e.status : undefined,
            }));
        }
        break;
      }
      case 'usage_update': {
        // Spec shape: context-window fill at the update's top level.
        const u = update as { used?: unknown; size?: unknown };
        this.tokenUsage = {
          used: typeof u.used === 'number' ? u.used : undefined,
          size: typeof u.size === 'number' ? u.size : undefined,
        };
        break;
      }
      default: {
        // Pre-spec adapters ride usage on a nested `usage` key instead.
        const usage = (update as { usage?: { used?: number; size?: number } }).usage;
        if (usage !== undefined) this.tokenUsage = { used: usage.used, size: usage.size };
        break;
      }
    }
  }
}

/** One-shot fold — the non-incremental entry point for tests and tooling. */
export function buildThreadRenderModel(
  events: readonly ThreadEvent[],
  agent: CodexLegacyAgentIdentity | null,
): ThreadRenderModel {
  return new ThreadRenderModelBuilder(agent).sync(events);
}

/**
 * How a permission request ended, classified by the CHOSEN option's kind —
 * not by mere presence of an optionId. Picking the agent's own "No, reject"
 * option is a denial and must never summarize as "Approved".
 *
 * `dismissed` is the no-classifiable-answer terminal state (timeout, turn
 * cancel, agent exit, or an optionId matching none of the offered options):
 * nobody approved or denied, the request just stopped mattering.
 */
export type PermissionOutcome =
  | { kind: 'approved'; auto: boolean; optionName: string | null }
  | { kind: 'denied'; auto: boolean; optionName: string | null }
  | { kind: 'dismissed' }
  | null;

export function resolvePermissionOutcome(
  item: Extract<RenderedItem, { kind: 'permission' }>,
): PermissionOutcome {
  const resolved = item.resolved;
  if (resolved === null) return null;
  if (resolved.optionId === null) {
    // No option chosen: an explicit user deny (our Deny button sends the
    // ACP `cancelled` outcome) vs. an automatic expiry.
    return resolved.auto
      ? { kind: 'dismissed' }
      : { kind: 'denied', auto: false, optionName: null };
  }
  const chosen = item.options.find((option) => option.optionId === resolved.optionId);
  if (chosen === undefined) {
    // An optionId that matches nothing in the request can't be classified —
    // claiming "approved" for it could mislabel a refusal.
    return { kind: 'dismissed' };
  }
  // Classify from both prefixes rather than treating "not a refusal" as assent.
  // The four known kinds partition cleanly, but a kind added by a later ACP
  // release would otherwise be labelled "Approved" — the wrong direction to be
  // wrong in for a security decision. An unrecognized kind is an answer we
  // can't read, which is what `dismissed` already means.
  const denied = chosen.kind.startsWith('reject');
  const approved = chosen.kind.startsWith('allow');
  if (!denied && !approved) return { kind: 'dismissed' };
  return {
    kind: denied ? 'denied' : 'approved',
    auto: resolved.auto,
    optionName: chosen.name,
  };
}

function messageId(update: SessionUpdate): string {
  const id = (update as { messageId?: unknown }).messageId;
  return typeof id === 'string' ? id : 'default';
}

function normalizeLocations(locations: unknown): Array<{ path: string; line?: number }> {
  if (!Array.isArray(locations)) return [];
  return locations
    .map((l) => l as { path?: unknown; line?: unknown })
    .filter((l) => typeof l.path === 'string')
    .map((l) => ({
      path: l.path as string,
      line: typeof l.line === 'number' ? l.line : undefined,
    }));
}

/**
 * Two error notices are "the same failure again" when everything the reader
 * would see matches: tone, headline string, and every field of the structured
 * failure the card composes copy from. `attempts` is deliberately excluded —
 * it's the counter we bump on match, not a match input.
 */
function isSameFailure(a: RenderedNotice, b: RenderedNotice): boolean {
  if (a.tone !== b.tone) return false;
  if (a.text !== b.text) return false;
  if ((a.failure === null) !== (b.failure === null)) return false;
  if (a.failure !== null && b.failure !== null) {
    if (a.failure.reason !== b.failure.reason) return false;
    if ((a.failure.agentMessage ?? '') !== (b.failure.agentMessage ?? '')) return false;
    if ((a.failure.machineDetail ?? '') !== (b.failure.machineDetail ?? '')) return false;
  }
  return true;
}

function mergeToolContent(call: RenderedToolCall, content: unknown): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    const b = block as Record<string, unknown>;
    if (b.type === 'diff' && typeof b.path === 'string' && typeof b.newText === 'string') {
      call.diffs.push({
        path: b.path,
        oldText: typeof b.oldText === 'string' ? b.oldText : null,
        newText: b.newText,
      });
    } else if (b.type === 'terminal' && typeof b.terminalId === 'string') {
      if (!call.terminalIds.includes(b.terminalId)) call.terminalIds.push(b.terminalId);
    } else if (b.type === 'content') {
      const text = textFromContent(b.content);
      if (text !== null) call.content.push(text);
    } else {
      const text = textFromContent(b);
      if (text !== null) call.content.push(text);
    }
  }
}
