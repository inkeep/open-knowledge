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
 */

import type {
  PermissionOption,
  SessionUpdate,
  ThreadEvent,
} from '@inkeep/open-knowledge-core/acp/thread-protocol';

interface RenderedMessage {
  kind: 'message';
  role: 'user' | 'agent' | 'thought';
  text: string;
  messageId: string;
}

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
  text: string;
  tone: 'info' | 'error';
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

export type RenderedItem =
  | RenderedMessage
  | RenderedToolCall
  | RenderedPermission
  | RenderedNotice
  | RenderedRuntimeConsent;

interface PlanEntry {
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

export class ThreadRenderModelBuilder {
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
      this.applyEvent(events[i]);
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
    this.lastConsentIndex = null;
    this.appliedCount = 0;
    this.dirty = true;
  }

  private applyEvent(event: ThreadEvent): void {
    this.dirty = true;
    switch (event.kind) {
      case 'user_message': {
        this.items.push({
          kind: 'message',
          role: 'user',
          text: event.content,
          messageId: `user-${this.items.length}`,
        });
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
        if (event.status === 'error' && event.detail) {
          this.items.push({ kind: 'notice', text: event.detail, tone: 'error' });
        } else if (event.status === 'auth_required' && event.detail) {
          this.items.push({ kind: 'notice', text: event.detail, tone: 'info' });
        }
        break;
      case 'permission_request': {
        const toolCallId = event.toolCall.toolCallId ?? null;
        const permission: RenderedPermission = {
          kind: 'permission',
          requestId: event.requestId,
          title: event.toolCall.title ?? 'Permission required',
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
        this.applyUpdate(event.update);
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

  private applyUpdate(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = textFromContent(update.content);
        if (text !== null) this.pushMessageChunk('agent', messageId(update), text);
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
          title: update.title ?? 'Tool call',
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
export function buildThreadRenderModel(events: readonly ThreadEvent[]): ThreadRenderModel {
  return new ThreadRenderModelBuilder().sync(events);
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
