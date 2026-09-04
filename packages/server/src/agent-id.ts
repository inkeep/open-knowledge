import { sanitizeGitIdentity } from './git-identity-sanitize.ts';

export const AGENT_ID_RE = /^[a-zA-Z0-9_-]+$/;

export const AGENT_ID_MAX_LEN = 64;

export function validateAgentId(rawAgentId: string | undefined | null): string | null {
  if (typeof rawAgentId !== 'string' || rawAgentId.length === 0) return null;
  if (rawAgentId.length > AGENT_ID_MAX_LEN) return null;
  if (!AGENT_ID_RE.test(rawAgentId)) return null;
  return rawAgentId;
}

export function toBroadcasterKey(rawAgentId: string): string {
  if (rawAgentId.startsWith('agent-')) return rawAgentId;
  return `agent-${rawAgentId}`;
}

/**
 * True iff the broadcaster-map key represents an agent whose state should
 * surface in the agent-presence / agent-focus UI.
 *
 * Form-write handlers attribute writes to `principal-<UUID>` (precedent #25
 * writer-ID taxonomy) — the local human editing their own properties is the
 * principal, not an agent. Routing those writes through the same broadcaster
 * call sites as MCP writes (the structural agent-presence test pins the
 * try/finally setPresence/touchMode shape, so handlers can't omit the calls)
 * would surface the user as their own agent: avatar in the editor chrome,
 * red agent-flash on the body text. Filter principal-prefixed ids at the
 * broadcaster boundary so handler shape stays valid AND non-agent writers
 * never reach the awareness fanout.
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

interface AgentBodyFields {
  rawAgentId: string | undefined;
  writerId: string | undefined;
  displayName: string;
  clientName: string | undefined;
  clientVersion: string | undefined;
  label: string | undefined;
  colorSeed: string | undefined;
}

export function parseAgentBodyFields(body: Record<string, unknown>): AgentBodyFields {
  const validated = validateAgentId(typeof body.agentId === 'string' ? body.agentId : null);
  const rawAgentId = validated ?? undefined;

  const writerId = rawAgentId !== undefined ? toBroadcasterKey(rawAgentId) : undefined;

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

  return { rawAgentId, writerId, displayName, clientName, clientVersion, label, colorSeed };
}
