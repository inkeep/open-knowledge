/**
 * OK-owned knowledge of each agent's permission posture — who gets to
 * authorize a risky action (file edit, command run) on a thread. ACP has no
 * handshake field for this: whether an agent routes actions through
 * `session/request_permission` is only observable behavior, so the verified
 * table below is keyed by registry agent id and maintained by hand. Lives in
 * core (not app) so the live thread UI and a future catalog/picker surface
 * can render one consistent answer.
 */

import type { SessionModeState } from '@agentclientprotocol/sdk';
import { isPermissiveMode } from './permissive-mode.ts';

export type AgentPermissionPosture =
  /** Routes risky actions through OK's permission prompts before acting. */
  | 'asks'
  /** Never asks OK; safety is governed by the agent's own declared mode. */
  | 'self-managed'
  /** Never asks and declares no modes — OK cannot intervene at all. */
  | 'autonomous'
  /** Unverified and not derivable from the session surface. */
  | 'unknown';

/**
 * Postures verified by observation, keyed by registry agent id. An entry
 * here beats derivation: Claude both declares modes and asks, and only the
 * asking is what the user needs to know.
 *
 * Sibling per-agent tables: `FEATURED_AGENT_IDS` and `ACP_AGENT_EDITOR_IDS`
 * in `packages/server/src/acp/registry.ts` — those live in server because
 * only the server reads them; this one lives in core because both sides of
 * the wire consume it. Touching agent ids? Check all three.
 */
export const VERIFIED_AGENT_POSTURES: {
  readonly [agentId: string]: AgentPermissionPosture | undefined;
} = {
  'claude-acp': 'asks',
  'codex-acp': 'self-managed',
  cursor: 'self-managed',
  'pi-acp': 'autonomous',
};

/**
 * Posture for one agent: the verified table first, else the one protocol
 * surface that implies self-management (declared modes), else unknown.
 * `modes` is the thread's live `SessionModeState` when a session is open;
 * pass null/undefined before the handshake resolves — an unverified agent
 * reads as `unknown` (not `autonomous`) until its modes are known, because
 * "we can't tell yet" must never render as "this agent never asks".
 *
 * A verified `asks` is a claim about the agent's asking modes, and the user
 * can switch to one that doesn't ask (Claude's `acceptEdits` /
 * `bypassPermissions`) — carried across threads by remembered settings, so
 * it can be wrong from a thread's first render. When the CURRENT mode reads
 * as permissive, `asks` demotes to `self-managed`: the honest answer, and
 * the one that can never contradict the permissive-mode warning driven by
 * the same detector. `currentMode` lets callers pass the mode surface they
 * actually render (config-option modes included); absent, the current entry
 * of `modes` is used.
 */
export function deriveAgentPosture(
  agentId: string,
  modes: SessionModeState | null | undefined,
  currentMode?: { id: string; name?: string } | null,
): AgentPermissionPosture {
  const current =
    currentMode ??
    (modes != null
      ? (modes.availableModes.find((mode) => mode.id === modes.currentModeId) ?? null)
      : null);
  const verified = VERIFIED_AGENT_POSTURES[agentId];
  if (verified !== undefined) {
    if (verified === 'asks' && current !== null && isPermissiveMode(current)) {
      return 'self-managed';
    }
    return verified;
  }
  if (modes != null && modes.availableModes.length > 0) return 'self-managed';
  return 'unknown';
}
