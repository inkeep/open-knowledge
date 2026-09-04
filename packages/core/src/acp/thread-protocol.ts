import type {
  AvailableCommand,
  ContentBlock,
  PermissionOption,
  PromptCapabilities,
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
  StopReason,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';

export type ThreadStatus =
  | 'installing'
  | 'spawning'
  | 'ready'
  | 'auth_required'
  | 'authenticating'
  | 'running'
  | 'awaiting_permission'
  | 'exited'
  | 'error';

export type ManagedRuntimeKind = 'node' | 'uv';

export type PiBridgeWriteAction =
  | 'unchanged'
  | 'written'
  | 'refreshed'
  | 'refused-foreign'
  | 'refused-unreadable'
  | 'failed';

export type PiTrustWriteAction =
  | 'already-trusted'
  | 'added'
  | 'skipped'
  | 'refused-unreadable'
  | 'failed';

export const THREAD_REOPEN_OP_TIMEOUT_MS = 90_000;

export type PiBridgeThreadState =
  | 'ready'
  | 'foreign-file'
  | 'unreadable-file'
  | 'bridge-failed'
  | 'trust-failed';

export interface ThreadAuthMethod {
  id: string;
  name: string;
  description?: string;
  kind?: string;
}

export interface ThreadFailureDetail {
  reason: 'auth-required' | 'connect' | 'session-setup' | 'prompt';
  agentMessage?: string;
  machineDetail?: string;
  authMethods?: ThreadAuthMethod[];
}

export interface ThreadAgentInfo {
  id: string;
  name: string;
  iconUrl?: string;
  source: 'registry' | 'custom';
  version?: string;
}

export type AttachmentPart =
  | {
      readonly kind: 'file';
      readonly path: string;
      readonly name: string;
    }
  | {
      readonly kind: 'folder';
      readonly path: string;
      readonly name: string;
    }
  | {
      readonly kind: 'image';
      readonly data: string;
      readonly mimeType: string;
      readonly name: string;
      readonly sizeBytes?: number;
    }
  | {
      readonly kind: 'blob';
      readonly data: string;
      readonly textPayload: boolean;
      readonly mimeType: string;
      readonly name: string;
      readonly sizeBytes?: number;
    };

export interface QueuedMessage {
  id: string;
  content: string;
  attachments?: readonly AttachmentPart[];
  ts: number;
  held?: boolean;
}

export interface SteerMessage {
  content: string;
  attachments?: readonly AttachmentPart[];
  ts: number;
}

export interface ThreadInfo {
  threadId: string;
  agent: ThreadAgentInfo;
  title: string;
  status: ThreadStatus;
  createdAt: number;
  lastActivityAt: number;
  promptCapabilities?: PromptCapabilities | null;
  modes?: SessionModeState | null;
  configOptions?: SessionConfigOption[] | null;
  availableCommands?: AvailableCommand[] | null;
  lastSeq: number;
  archived?: boolean;
  queue?: QueuedMessage[];
  steer?: SteerMessage;
  signInOutput?: string[];
}

export type ThreadEvent =
  | {
      kind: 'user_message';
      content: string;
      attachments?: readonly AttachmentPart[];
      ts: number;
    }
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
      optionId: string | null;
      auto: boolean;
      ts: number;
    }
  | { kind: 'turn_started'; ts: number }
  | { kind: 'turn_ended'; stopReason: StopReason; ts: number }
  | {
      kind: 'status';
      status: ThreadStatus;
      detail?: string;
      failure?: ThreadFailureDetail;
      ts: number;
    }
  | { kind: 'title_changed'; title: string; ts: number }
  | { kind: 'agent_stderr'; line: string; ts: number }
  | {
      kind: 'runtime_consent_request';
      requestId: string;
      runtime: ManagedRuntimeKind;
      displayName: string;
      provides: string;
      version: string;
      approxSizeMB: number;
      sourceHost: string;
      agentName: string;
      reason?: 'missing' | 'broken' | 'damaged';
      ts: number;
    }
  | {
      kind: 'runtime_consent_resolved';
      requestId: string;
      decision: 'granted' | 'declined' | 'timeout';
      ts: number;
    }
  | {
      kind: 'pi_bridge_consent_request';
      requestId: string;
      agentName: string;
      bridgePath: string;
      cwd: string;
      otherExtensions?: readonly string[];
      ts: number;
    }
  | {
      kind: 'pi_bridge_consent_resolved';
      requestId: string;
      decision: 'granted' | 'declined' | 'timeout';
      ts: number;
    }
  | {
      kind: 'pi_bridge_status';
      requestId?: string;
      state: PiBridgeThreadState;
      bridgePath: string;
      bridge?: PiBridgeWriteAction;
      trust?: PiTrustWriteAction;
      detail?: string;
      ts: number;
    }
  | {
      kind: 'runtime_install_progress';
      runtime: ManagedRuntimeKind;
      phase: 'downloading' | 'verifying' | 'extracting';
      receivedBytes?: number;
      totalBytes?: number;
      ts: number;
    }
  | {
      kind: 'terminal_created';
      terminalId: string;
      command: string;
      args: string[];
      ts: number;
    }
  | {
      kind: 'terminal_output';
      terminalId: string;
      chunk: string;
      ts: number;
    }
  | {
      kind: 'terminal_exit';
      terminalId: string;
      exitCode: number | null;
      signal: string | null;
      ts: number;
    };

export type ThreadClientFrame =
  | {
      op: 'create';
      reqId: string;
      agent: { source: 'registry' | 'custom'; id: string };
      prompt?: string;
      attachments?: readonly AttachmentPart[];
      docName?: string;
      titleHint?: string;
      settings?: { config?: Record<string, string | boolean>; modeId?: string };
    }
  | { op: 'subscribe'; threadId: string; sinceSeq?: number }
  | { op: 'unsubscribe'; threadId: string }
  | {
      op: 'prompt';
      threadId: string;
      reqId: string;
      content: string;
      attachments?: readonly AttachmentPart[];
    }
  | {
      op: 'steer';
      threadId: string;
      reqId: string;
      content: string;
      attachments?: readonly AttachmentPart[];
    }
  | {
      op: 'queue_edit';
      threadId: string;
      id: string;
      content: string;
      reqId?: string;
    }
  | {
      op: 'queue_hold';
      threadId: string;
      id: string;
      held: boolean;
    }
  | {
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
      op: 'runtime_consent_response';
      threadId: string;
      requestId: string;
      outcome: { kind: 'granted' } | { kind: 'declined' };
    }
  | {
      op: 'pi_bridge_consent_response';
      threadId: string;
      requestId: string;
      outcome: { kind: 'granted' } | { kind: 'declined' };
    }
  | { op: 'set_mode'; threadId: string; modeId: string }
  | {
      op: 'set_config_option';
      threadId: string;
      configId: string;
      value: string | boolean;
    }
  | { op: 'close'; threadId: string }
  | {
      op: 'rename';
      threadId: string;
      title: string;
    }
  | {
      op: 'resume';
      threadId: string;
      reqId: string;
      prompt?: string;
      attachments?: readonly AttachmentPart[];
    }
  | {
      op: 'retry';
      threadId: string;
      reqId: string;
    }
  | {
      op: 'authenticate';
      threadId: string;
      reqId: string;
      methodId: string;
    }
  | {
      op: 'delete';
      threadId: string;
    }
  | { op: 'list' };

export type ThreadServerFrame =
  | { op: 'created'; reqId: string; info: ThreadInfo }
  | { op: 'resumed'; reqId: string; info: ThreadInfo }
  | { op: 'retried'; reqId: string; info: ThreadInfo }
  | { op: 'authenticated'; reqId: string; info: ThreadInfo }
  | { op: 'subscribed'; threadId: string; fromSeq: number; info: ThreadInfo }
  | { op: 'event'; threadId: string; seq: number; event: ThreadEvent }
  | {
      op: 'events';
      threadId: string;
      fromSeq: number;
      events: ThreadEvent[];
    }
  | {
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
  'pi_bridge_consent_response',
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

function isValidAttachmentPartArray(value: unknown): value is readonly AttachmentPart[] {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  for (const part of value) {
    if (typeof part !== 'object' || part === null) return false;
    const p = part as Record<string, unknown>;
    if (p.kind === 'file' || p.kind === 'folder') {
      if (typeof p.path !== 'string' || typeof p.name !== 'string') return false;
    } else if (p.kind === 'image') {
      if (
        typeof p.data !== 'string' ||
        typeof p.mimeType !== 'string' ||
        typeof p.name !== 'string'
      )
        return false;
      if (p.sizeBytes !== undefined && typeof p.sizeBytes !== 'number') return false;
    } else if (p.kind === 'blob') {
      if (
        typeof p.data !== 'string' ||
        typeof p.textPayload !== 'boolean' ||
        typeof p.mimeType !== 'string' ||
        typeof p.name !== 'string'
      ) {
        return false;
      }
      if (p.sizeBytes !== undefined && typeof p.sizeBytes !== 'number') return false;
    } else {
      return false;
    }
  }
  return true;
}

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
      if (!isValidAttachmentPartArray(frame.attachments)) return null;
      return frame as unknown as ThreadClientFrame;
    }
    case 'subscribe':
      if (!str('threadId')) return null;
      if (frame.sinceSeq !== undefined && typeof frame.sinceSeq !== 'number') return null;
      return frame as unknown as ThreadClientFrame;
    case 'prompt':
      if (!str('threadId') || !str('reqId') || typeof frame.content !== 'string') return null;
      if (!isValidAttachmentPartArray(frame.attachments)) return null;
      return frame as unknown as ThreadClientFrame;
    case 'steer': {
      if (!str('threadId') || !str('reqId')) return null;
      if (typeof frame.content !== 'string') return null;
      if (!isValidAttachmentPartArray(frame.attachments)) return null;
      const hasAttachments = Array.isArray(frame.attachments) && frame.attachments.length > 0;
      if (frame.content === '' && !hasAttachments) return null;
      return frame as unknown as ThreadClientFrame;
    }
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
      return frame as unknown as ThreadClientFrame;
    }
    case 'pi_bridge_consent_response': {
      if (!str('threadId') || !str('requestId')) return null;
      const outcome = frame.outcome as Record<string, unknown> | undefined;
      if (typeof outcome !== 'object' || outcome === null) return null;
      if (outcome.kind !== 'granted' && outcome.kind !== 'declined') return null;
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
      if (!isValidAttachmentPartArray(frame.attachments)) return null;
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

export type {
  AvailableCommand,
  ContentBlock,
  PermissionOption,
  PromptCapabilities,
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
  StopReason,
  ToolCallUpdate,
};
