import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { CodexLegacyAgentIdentity } from '@inkeep/open-knowledge-core/acp/codex-legacy-notice';
import { isCodexLegacyWarningUpdate } from '@inkeep/open-knowledge-core/acp/codex-legacy-notice';
import type { ThreadEvent } from '@inkeep/open-knowledge-core/acp/thread-protocol';

const EVENT_TEXT_CAP = 16_000;

function truncateEventText(text: string): string {
  if (text.length <= EVENT_TEXT_CAP) return text;
  return `${text.slice(0, EVENT_TEXT_CAP)}\n… [truncated ${text.length - EVENT_TEXT_CAP} chars]`;
}

export function boundSessionUpdateForLog(update: SessionUpdate): SessionUpdate {
  const u = update as { sessionUpdate?: string; content?: unknown };
  if (
    (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update') ||
    !Array.isArray(u.content)
  ) {
    return update;
  }
  let changed = false;
  const content = u.content.map((block) => {
    const b = block as Record<string, unknown>;
    if (b.type === 'diff') {
      const oldText = typeof b.oldText === 'string' ? truncateEventText(b.oldText) : b.oldText;
      const newText = typeof b.newText === 'string' ? truncateEventText(b.newText) : b.newText;
      if (oldText !== b.oldText || newText !== b.newText) {
        changed = true;
        return { ...b, oldText, newText };
      }
      return block;
    }
    if (b.type === 'content') {
      const inner = b.content as { type?: string; text?: string } | undefined;
      if (inner?.type === 'text' && typeof inner.text === 'string') {
        const text = truncateEventText(inner.text);
        if (text !== inner.text) {
          changed = true;
          return { ...b, content: { ...inner, text } };
        }
      }
      return block;
    }
    return block;
  });
  if (!changed) return update;
  return { ...update, content } as SessionUpdate;
}

const COALESCIBLE_CHUNK_KINDS = new Set([
  'agent_message_chunk',
  'agent_thought_chunk',
  'user_message_chunk',
]);

const COALESCE_TEXT_CAP = 16_000;

interface ChunkUpdate {
  sessionUpdate: string;
  messageId?: unknown;
  content?: { type?: string; text?: string } | unknown;
}

function chunkText(content: unknown): string | null {
  if (typeof content !== 'object' || content === null) return null;
  const c = content as { type?: string; text?: string };
  return c.type === 'text' && typeof c.text === 'string' ? c.text : null;
}

function chunkMessageId(u: ChunkUpdate): string {
  return typeof u.messageId === 'string' ? u.messageId : 'default';
}

export interface StreamedChunk {
  readonly stream: string;
  readonly text: string;
}

export function streamedChunkOf(
  event: unknown,
  agent: CodexLegacyAgentIdentity | null,
): StreamedChunk | null {
  if (typeof event !== 'object' || event === null) return null;
  const e = event as { kind?: unknown; terminalId?: unknown; chunk?: unknown; update?: unknown };
  if (e.kind === 'terminal_output') {
    return typeof e.terminalId === 'string' && typeof e.chunk === 'string'
      ? { stream: `terminal ${e.terminalId}`, text: e.chunk }
      : null;
  }
  if (e.kind !== 'session_update' || typeof e.update !== 'object' || e.update === null) {
    return null;
  }
  const update = e.update as ChunkUpdate;
  if (!COALESCIBLE_CHUNK_KINDS.has(update.sessionUpdate)) return null;
  if (isCodexLegacyWarningUpdate(update as SessionUpdate, agent)) return null;
  const text = chunkText(update.content);
  return text === null
    ? null
    : { stream: `${update.sessionUpdate} ${chunkMessageId(update)}`, text };
}

export function coalesceChunkInto(
  prev: ThreadEvent,
  next: ThreadEvent,
  agent: CodexLegacyAgentIdentity,
): boolean {
  const before = streamedChunkOf(prev, agent);
  const after = streamedChunkOf(next, agent);
  if (before === null || after === null || before.stream !== after.stream) return false;
  if (before.text.length >= COALESCE_TEXT_CAP) return false;
  if (prev.kind === 'terminal_output') {
    prev.chunk += after.text;
    return true;
  }
  if (prev.kind !== 'session_update') return false;
  (prev.update as ChunkUpdate).content = { type: 'text', text: before.text + after.text };
  return true;
}
