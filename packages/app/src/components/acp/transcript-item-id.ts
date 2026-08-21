import type { RenderedItem } from '@/lib/acp/thread-event-model';

// Stable, unique per-item id for the scroller's anchoring/measurement (its
// messageId prop) and the React key. Tool calls, permissions and consents carry
// a unique domain id. A message's `messageId` is NOT unique — adapters that send
// none all key to 'default', and a fresh block starts whenever anything
// interrupts the tail — and notices have none at all, so both fold in the index.
// The index is stable because the transcript is append-only and coalescing
// rewrites an item in place at the same position.
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
  }
}
