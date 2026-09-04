import type { SessionUpdate } from '@agentclientprotocol/sdk';

export interface CodexLegacyAgentIdentity {
  readonly source: 'registry' | 'custom';
  readonly id: string;
}

const CODEX_REGISTRY_AGENT_ID = 'codex-acp';

const LEGACY_WARNING_PREFIXES = ['Warning: ', 'Config warning: '] as const;

const LEGACY_WARNING_TERMINATOR = '\n\n';

export function isCodexLegacyWarningUpdate(
  update: SessionUpdate | null | undefined,
  agent: CodexLegacyAgentIdentity | null | undefined,
): boolean {
  if (agent === null || agent === undefined) return false;
  if (agent.source !== 'registry' || agent.id !== CODEX_REGISTRY_AGENT_ID) return false;

  if (typeof update !== 'object' || update === null) return false;
  const candidate = update as { sessionUpdate?: unknown; messageId?: unknown; content?: unknown };
  if (candidate.sessionUpdate !== 'agent_message_chunk') return false;

  if (candidate.messageId !== undefined) return false;

  const content = candidate.content;
  if (typeof content !== 'object' || content === null) return false;
  const block = content as { type?: unknown; text?: unknown };
  if (block.type !== 'text' || typeof block.text !== 'string') return false;

  const text = block.text;
  if (!text.endsWith(LEGACY_WARNING_TERMINATOR)) return false;
  return LEGACY_WARNING_PREFIXES.some((prefix) => text.startsWith(prefix));
}
