import type { RenderedItem } from '@/lib/acp/thread-event-model';

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
      return `pi-bridge:${item.prompt?.requestId ?? index}`;
    case 'notice':
      return `notice:${index}`;
    case 'agent_notice':
      return `agent-notice:${index}`;
  }
}
