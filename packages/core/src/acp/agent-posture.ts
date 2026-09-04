import type { SessionModeState } from '@agentclientprotocol/sdk';
import { isPermissiveMode } from './permissive-mode.ts';

export type AgentPermissionPosture = 'asks' | 'self-managed' | 'autonomous' | 'unknown';

export const VERIFIED_AGENT_POSTURES: {
  readonly [agentId: string]: AgentPermissionPosture | undefined;
} = {
  'claude-acp': 'asks',
  'codex-acp': 'self-managed',
  cursor: 'self-managed',
  'pi-acp': 'autonomous',
};

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
