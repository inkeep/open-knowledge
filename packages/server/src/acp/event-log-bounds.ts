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

export function coalesceChunkInto(
  prev: ThreadEvent,
  next: ThreadEvent,
  agent: CodexLegacyAgentIdentity,
): boolean {
  if (prev.kind === 'terminal_output' && next.kind === 'terminal_output') {
    if (prev.terminalId !== next.terminalId) return false;
    if (prev.chunk.length >= COALESCE_TEXT_CAP) return false;
    prev.chunk += next.chunk;
    return true;
  }
  if (prev.kind !== 'session_update' || next.kind !== 'session_update') return false;
  if (
    isCodexLegacyWarningUpdate(prev.update, agent) ||
    isCodexLegacyWarningUpdate(next.update, agent)
  ) {
    return false;
  }
  const p = prev.update as ChunkUpdate;
  const n = next.update as ChunkUpdate;
  if (p.sessionUpdate !== n.sessionUpdate || !COALESCIBLE_CHUNK_KINDS.has(n.sessionUpdate)) {
    return false;
  }
  if (chunkMessageId(p) !== chunkMessageId(n)) return false;
  const prevText = chunkText(p.content);
  const nextText = chunkText(n.content);
  if (prevText === null || nextText === null) return false;
  if (prevText.length >= COALESCE_TEXT_CAP) return false;
  p.content = { type: 'text', text: prevText + nextText };
  return true;
}
