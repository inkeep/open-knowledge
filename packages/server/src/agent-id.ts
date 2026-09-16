import { sanitizeGitIdentity } from './git-identity-sanitize.ts';
import { getLogger } from './logger.ts';

export const AGENT_ID_RE = /^[a-zA-Z0-9_-]+$/;

export const AGENT_ID_MAX_LEN = 64;

type AgentIdRejection = 'not-a-string' | 'empty' | 'too-long' | 'charset';

function classifyAgentIdRejection(suppliedAgentId: unknown): AgentIdRejection | null {
  if (typeof suppliedAgentId !== 'string') return 'not-a-string';
  if (suppliedAgentId.length === 0) return 'empty';
  if (suppliedAgentId.length > AGENT_ID_MAX_LEN) return 'too-long';
  if (!AGENT_ID_RE.test(suppliedAgentId)) return 'charset';
  return null;
}

export function validateAgentId(rawAgentId: string | undefined | null): string | null {
  if (typeof rawAgentId !== 'string') return null;
  return classifyAgentIdRejection(rawAgentId) === null ? rawAgentId : null;
}

export function toBroadcasterKey(rawAgentId: string): string {
  if (rawAgentId.startsWith('agent-')) return rawAgentId;
  return `agent-${rawAgentId}`;
}

/**
 * Form-write handlers attribute writes to `principal-<UUID>` (precedent #25 writer-ID taxonomy) —
 * the local human editing their own properties is the principal, not an agent.
 */
export function isPresenceEligibleAgentId(agentId: string): boolean {
  return !agentId.startsWith('principal-');
}

export function resolveAgentType(clientName: string | undefined): string {
  if (!clientName) return 'bot';
  const lower = clientName.toLowerCase();
  if (lower.includes('claude')) return 'claude';
  if (lower.startsWith('local-agent-mode-')) return 'claude';
  if (lower.includes('cursor')) return 'cursor';
  if (lower.includes('codex')) return 'codex';
  if (lower.includes('cline')) return 'cline';
  if (lower.includes('windsurf')) return 'windsurf';
  return 'bot';
}

export const AGENT_NAME_MAX_LEN = 128;

export const ANONYMOUS_WRITER_ID = 'principal-anonymous';

export const UNIDENTIFIED_WRITER_ID = 'claude-1';

const IDENTITY_ABSENT_WRITER_IDS: ReadonlySet<string> = new Set([
  ANONYMOUS_WRITER_ID,
  UNIDENTIFIED_WRITER_ID,
]);

export type RawWriterId = string & { readonly __brand: 'RawWriterId' };

function brandWriterId(writerId: string): RawWriterId {
  return writerId as RawWriterId;
}

export function sessionWriterId(session: { agentId: string }): RawWriterId | undefined {
  if (IDENTITY_ABSENT_WRITER_IDS.has(session.agentId)) return undefined;
  return brandWriterId(session.agentId);
}

interface AgentBodyFields {
  rawAgentId: string | undefined;
  suppliedWriterId: RawWriterId | undefined;
  displayName: string;
  clientName: string | undefined;
  clientVersion: string | undefined;
  label: string | undefined;
  colorSeed: string | undefined;
}

export function parseAgentBodyFields(body: Record<string, unknown>): AgentBodyFields {
  const suppliedAgentId = body.agentId;
  const rejection =
    suppliedAgentId === undefined ? null : classifyAgentIdRejection(suppliedAgentId);
  const rawAgentId =
    rejection === null && typeof suppliedAgentId === 'string' ? suppliedAgentId : undefined;
  if (rejection !== null) {
    getLogger('agent-write').warn(
      {
        event: 'agent-id-validation-failed',
        reason: rejection,
        agentIdType: typeof suppliedAgentId,
        agentIdMaxLen: AGENT_ID_MAX_LEN,
      },
      'request agentId failed validation and was discarded before writer-identity resolution',
    );
  }

  const suppliedWriterId =
    rawAgentId !== undefined ? brandWriterId(toBroadcasterKey(rawAgentId)) : undefined;

  const displayName =
    typeof body.agentName === 'string' ? sanitizeGitIdentity(body.agentName) : 'Claude';

  const clientName =
    typeof body.clientName === 'string' ? sanitizeGitIdentity(body.clientName) : undefined;
  const clientVersion =
    typeof body.clientVersion === 'string' ? sanitizeGitIdentity(body.clientVersion) : undefined;
  const label = typeof body.label === 'string' ? sanitizeGitIdentity(body.label) : undefined;

  const colorSeed =
    typeof body.colorSeed === 'string' && body.colorSeed.length > 0
      ? body.colorSeed.slice(0, AGENT_NAME_MAX_LEN)
      : undefined;

  return {
    rawAgentId,
    suppliedWriterId,
    displayName,
    clientName,
    clientVersion,
    label,
    colorSeed,
  };
}
