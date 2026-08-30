import type { RenderedItem } from '@/lib/acp/thread-event-model';

// Stable, unique per-item id for the scroller's anchoring/measurement (its
// messageId prop) and the React key. Tool calls, permissions and consents carry
// a unique domain id. A message's `messageId` is NOT unique — adapters that send
// none all key to 'default', and a fresh block starts whenever anything
// interrupts the tail — and notices have none at all, so both fold in the index.
// `index` MUST be a position in `model.items`, which is append-only and where
// coalescing rewrites an item in place rather than moving it. A position in a
// filtered view (the folded or visible transcript) shifts whenever something
// ahead of it is removed, which renumbers every later key and remounts the row.
export function transcriptItemId(item: RenderedItem, index: number): string {
  switch (item.kind) {
    case 'message':
      return `msg:${index}:${item.messageId}`;
    case 'tool_call':
      return `tool:${item.toolCallId}`;
    case 'permission':
      return `perm:${item.requestId}`;
    case 'runtime_consent':
      return `consent:${item.requestId}`;
    case 'pi_bridge':
      // A prompt-less row (a limitation notice) has no domain id of its own.
      return `pi-bridge:${item.prompt?.requestId ?? index}`;
    case 'notice':
      return `notice:${index}`;
    case 'agent_notice':
      // Runtime status carries no producer identity of its own, and two
      // identical warnings in one turn are two rows.
      return `agent-notice:${index}`;
  }
}
