import type { HandoffTarget, TerminalCli } from '@inkeep/open-knowledge-core';
import {
  desktopEnabledKey,
  type EnabledOverrides,
  inAppEnabledKey,
  resolveEnabled,
  terminalEnabledKey,
} from './enabled-agents';

export function isInAppAgentEnabled(
  overrides: EnabledOverrides,
  source: string,
  id: string,
  isRegistered: boolean,
  supported: boolean | undefined,
): boolean {
  if (supported === false) return false;
  return resolveEnabled(overrides[inAppEnabledKey(source, id)], isRegistered);
}

export function isTerminalCliEnabled(
  overrides: EnabledOverrides,
  cli: TerminalCli,
  installed: Partial<Record<TerminalCli, boolean>>,
): boolean {
  return resolveEnabled(overrides[terminalEnabledKey(cli)], installed[cli] !== false);
}

export function isDesktopTargetEnabled(
  overrides: EnabledOverrides,
  targetId: HandoffTarget,
  installed: boolean | null | undefined,
): boolean {
  return resolveEnabled(overrides[desktopEnabledKey(targetId)], installed === true);
}
