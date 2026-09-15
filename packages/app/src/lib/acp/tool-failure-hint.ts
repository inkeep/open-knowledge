import {
  OPEN_KNOWLEDGE_MCP_WRITE_TOOLS,
  SERVER_TIMEOUT_ERROR_PREFIX,
  SERVER_UNREACHABLE_ERROR_PREFIX,
} from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import {
  type RenderedPermission,
  type RenderedToolCall,
  resolvePermissionOutcome,
} from '@/lib/acp/thread-event-model';
import { openKnowledgeToolName } from '@/lib/acp/tool-call-display';

export type ToolFailureClass =
  | 'permission-denied'
  | 'server-unreachable'
  | 'server-timeout'
  | 'server-timeout-read';

type ToolCallOutcome = Pick<RenderedToolCall, 'status' | 'title' | 'rawInput' | 'content'>;

const LEGACY_TIMEOUT_ERROR = `${SERVER_UNREACHABLE_ERROR_PREFIX} The operation was aborted due to timeout`;

export function classifyToolFailure(
  call: ToolCallOutcome,
  permission?: RenderedPermission,
): ToolFailureClass | null {
  if (call.status !== 'failed') return null;
  const outcome = permission === undefined ? null : resolvePermissionOutcome(permission);
  if (outcome?.kind === 'denied' && !outcome.auto) return 'permission-denied';
  const tool = openKnowledgeToolName(call);
  if (tool === null) return null;
  const text = call.content.join('\n');
  if (text.includes(SERVER_TIMEOUT_ERROR_PREFIX) || text.includes(LEGACY_TIMEOUT_ERROR)) {
    const mutating: readonly string[] = OPEN_KNOWLEDGE_MCP_WRITE_TOOLS;
    return mutating.includes(tool) ? 'server-timeout' : 'server-timeout-read';
  }
  if (text.includes(SERVER_UNREACHABLE_ERROR_PREFIX)) return 'server-unreachable';
  return null;
}

export function toolFailureHint(
  call: ToolCallOutcome,
  permission?: RenderedPermission,
): string | null {
  const failure = classifyToolFailure(call, permission);
  switch (failure) {
    case null:
      return null;
    case 'permission-denied':
      return t`You denied this. To let it run, ask the agent to try again and approve it.`;
    case 'server-unreachable':
      return t`The agent's OpenKnowledge tools couldn't reach the server. Ask the agent to try again, and if it keeps failing, start a new chat.`;
    case 'server-timeout':
      return t`The OpenKnowledge server took too long to answer, and the change may still have gone through. Ask the agent to check before trying again.`;
    case 'server-timeout-read':
      return t`The OpenKnowledge server took too long to answer. Ask the agent to try again.`;
    default:
      return failure satisfies never;
  }
}
