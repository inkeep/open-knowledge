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

type RenderedMessage =
  | {
      kind: 'message';
      role: 'user';
      text: string;
      messageId: string;
      attachments?: readonly import('@inkeep/open-knowledge-core/acp/thread-protocol').AttachmentPart[];
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
  diffs: Array<{ path: string; oldText: string | null; newText: string }>;
  terminalIds: string[];
  content: string[];
  locations: Array<{ path: string; line?: number }>;
  rawInput: unknown;
}

export interface RenderedPermission {
  kind: 'permission';
  requestId: string;
  title: string;
  toolKind: string;
  options: PermissionOption[];
  resolved: { optionId: string | null; auto: boolean } | null;
  toolCallId: string | null;
  mergedIntoToolCall: boolean;
}

interface RenderedNotice {
  kind: 'notice';
  text: string;
  tone: 'info' | 'error';
  failure: ThreadFailureDetail | null;
  superseded?: boolean;
  attempts: number;
}

interface RenderedAgentNotice {
  kind: 'agent_notice';
  source: 'codex_legacy';
  severity: 'warning';
  text: string;
  seq: number;
}

export interface RenderedTerminal {
  terminalId: string;
  command: string;
  args: string[];
  output: string;
  truncated: boolean;
  exit: { exitCode: number | null; signal: string | null } | null;
}

const TERMINAL_RENDER_CHAR_CAP = 64_000;

interface RenderedRuntimeConsent {
  kind: 'runtime_consent';
  requestId: string;
  runtime: 'node' | 'uv';
  displayName: string;
  provides: string;
  version: string;
  approxSizeMB: number;
  sourceHost: string;
  agentName: string;
  reason: 'missing' | 'broken' | 'damaged';
  resolved: 'granted' | 'declined' | 'timeout' | null;
  install: 'running' | 'done' | 'failed' | null;
  progress: { receivedBytes: number; totalBytes: number | null } | null;
}

interface RenderedPiBridgePrompt {
  requestId: string;
  agentName: string;
  cwd: string;
  otherExtensions: readonly string[];
}

interface RenderedPiBridgeOutcome {
  state: PiBridgeThreadState;
  detail: string | null;
}

interface RenderedPiBridgeBase {
  kind: 'pi_bridge';
  bridgePath: string;
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
  turnActive: boolean;
  tokenUsage: { used?: number; size?: number } | null;
  terminals: Record<string, RenderedTerminal>;
  permissionsByToolCall: Record<string, RenderedPermission>;
}

function textFromContent(content: unknown): string | null {
  if (typeof content !== 'object' || content === null) return null;
  const c = content as { type?: string; text?: string };
  return c.type === 'text' && typeof c.text === 'string' ? c.text : null;
}

function isSupersededByReady(failure: ThreadFailureDetail | null): boolean {
  return (
    failure !== null &&
    (failure.reason === 'connect' ||
      failure.reason === 'session-setup' ||
      failure.reason === 'auth-required')
  );
}

export class ThreadRenderModelBuilder {
  constructor(private readonly agent: CodexLegacyAgentIdentity | null) {}

  private items: RenderedItem[] = [];
  private plan: PlanEntry[] = [];
  private turnActive = false;
  private tokenUsage: ThreadRenderModel['tokenUsage'] = null;
  private terminals: Record<string, RenderedTerminal> = {};
  private toolCallIndex = new Map<string, number>();
  private permissionIndex = new Map<string, number>();
  private permissionByToolCall = new Map<string, number>();
  private permissionsByToolCall: Record<string, RenderedPermission> = {};
  private messageIndex = new Map<string, number>();
  private runtimeConsentIndex = new Map<string, number>();
  private piBridgeIndex = new Map<string, number>();
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

  sync(events: readonly ThreadEvent[]): ThreadRenderModel {
    if (events.length < this.appliedCount) this.reset();
    for (let i = this.appliedCount; i < events.length; i++) {
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
        if (event.status === 'exited') this.turnActive = false;
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
          if (event.failure !== undefined || (event.detail ?? '') !== '') {
            const next: RenderedNotice = {
              kind: 'notice',
              text: event.detail ?? '',
              tone: event.status === 'error' ? 'error' : 'info',
              failure: event.failure ?? null,
              attempts: 1,
            };
            const last = this.items[this.items.length - 1];
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
        this.mergePermissionInto(update.toolCallId);
        break;
      }
      case 'tool_call_update': {
        const index = this.toolCallIndex.get(update.toolCallId);
        if (index === undefined) break;
        const existing = this.items[index];
        if (existing.kind !== 'tool_call') break;
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
        const u = update as { used?: unknown; size?: unknown };
        this.tokenUsage = {
          used: typeof u.used === 'number' ? u.used : undefined,
          size: typeof u.size === 'number' ? u.size : undefined,
        };
        break;
      }
      default: {
        const usage = (update as { usage?: { used?: number; size?: number } }).usage;
        if (usage !== undefined) this.tokenUsage = { used: usage.used, size: usage.size };
        break;
      }
    }
  }
}

export function buildThreadRenderModel(
  events: readonly ThreadEvent[],
  agent: CodexLegacyAgentIdentity | null,
): ThreadRenderModel {
  return new ThreadRenderModelBuilder(agent).sync(events);
}

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
    return resolved.auto
      ? { kind: 'dismissed' }
      : { kind: 'denied', auto: false, optionName: null };
  }
  const chosen = item.options.find((option) => option.optionId === resolved.optionId);
  if (chosen === undefined) {
    return { kind: 'dismissed' };
  }
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
