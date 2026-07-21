/**
 * Size bounds for the retained thread event log. Tool-call diffs can embed
 * whole-file before/after text; the log keeps thousands of events per thread
 * and re-sends them on every replay, so unbounded payloads turn one busy
 * doc-rewriting agent into hundreds of MB of server memory and replay
 * traffic. Only the transcript's retained copy is bounded — the live
 * document content is untouched.
 */

import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { ThreadEvent } from '@inkeep/open-knowledge-core/acp/thread-protocol';

const EVENT_TEXT_CAP = 16_000;

function truncateEventText(text: string): string {
  if (text.length <= EVENT_TEXT_CAP) return text;
  return `${text.slice(0, EVENT_TEXT_CAP)}\n… [truncated ${text.length - EVENT_TEXT_CAP} chars]`;
}

/**
 * Bound oversized tool-call payloads (diffs, content blocks) before
 * retention. Returns the input unchanged (same reference) when nothing
 * exceeds the cap — the common path allocates nothing.
 */
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

/**
 * Streaming `session_update` chunk kinds the app coalesces into one message
 * bubble (see `pushMessageChunk` in the app's thread-event-model). Folding the
 * retained transcript along the same lines keeps disk == what the UI renders.
 */
const COALESCIBLE_CHUNK_KINDS = new Set([
  'agent_message_chunk',
  'agent_thought_chunk',
  'user_message_chunk',
]);

/**
 * Stop growing a folded chunk past this many chars — the next chunk starts a
 * fresh event instead. Bounds a single streamed answer to a handful of NDJSON
 * lines rather than one unbounded one (mirrors EVENT_TEXT_CAP for tool diffs).
 */
const COALESCE_TEXT_CAP = 16_000;

interface ChunkUpdate {
  sessionUpdate: string;
  messageId?: unknown;
  content?: { type?: string; text?: string } | unknown;
}

/** The chunk's single text block, or null when it isn't a `{type:'text'}` block. */
function chunkText(content: unknown): string | null {
  if (typeof content !== 'object' || content === null) return null;
  const c = content as { type?: string; text?: string };
  return c.type === 'text' && typeof c.text === 'string' ? c.text : null;
}

/** Matches the app's `messageId(update)`: string messageId, else 'default'. */
function chunkMessageId(u: ChunkUpdate): string {
  return typeof u.messageId === 'string' ? u.messageId : 'default';
}

/**
 * Fold `next` into `prev` when both are consecutive streamed text chunks of
 * the SAME stream — same `sessionUpdate` kind and messageId, both text
 * content — by appending next's text onto prev's in place. Returns true when
 * folded (the caller then drops `next`, so it consumes no seq); false when the
 * pair isn't mergeable or prev already hit {@link COALESCE_TEXT_CAP}.
 *
 * The predicate is a safe subset of the app's own role:messageId chunk
 * coalescing: it never folds two chunks the UI would keep in separate bubbles
 * (a thought↔message switch, a differing messageId, or an interleaved tool
 * call / permission all break the run), so concatenation stays faithful. It
 * may leave adjacent chunks unfolded across a flush boundary — the app merges
 * those on its side, exactly as it already does with today's per-word events.
 *
 * Callable ONLY on the not-yet-flushed tail event: growing an event whose seq
 * was already broadcast/persisted would break the line-index-IS-the-seq
 * contract. A fold assigns no new seq, so that contract is preserved.
 */
export function coalesceChunkInto(prev: ThreadEvent, next: ThreadEvent): boolean {
  // Terminal output folds along the same lines as streamed text: the app
  // concatenates a terminal's chunks anyway, so consecutive chunks of the
  // SAME terminal merge into one retained event (and one seq).
  if (prev.kind === 'terminal_output' && next.kind === 'terminal_output') {
    if (prev.terminalId !== next.terminalId) return false;
    if (prev.chunk.length >= COALESCE_TEXT_CAP) return false;
    prev.chunk += next.chunk;
    return true;
  }
  if (prev.kind !== 'session_update' || next.kind !== 'session_update') return false;
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
