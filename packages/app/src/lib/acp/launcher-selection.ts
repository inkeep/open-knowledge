import type { HandoffTarget, InstallState, TerminalCli } from '@inkeep/open-knowledge-core';
import { TERMINAL_CLI_IDS } from '@inkeep/open-knowledge-core';
import { VISIBLE_TARGETS } from '@/lib/handoff/targets';
import { parseStickyCliId, parseStickyThreadAgent } from '../unified-agent-store';
import {
  isDesktopTargetEnabled,
  isInAppAgentEnabled,
  isTerminalCliEnabled,
} from './agent-visibility';
import { desktopEnabledKey, type EnabledOverrides } from './enabled-agents';
import type { RegisteredAgent } from './registered-agents';

export type LauncherSelection =
  | { readonly kind: 'thread'; readonly agent: RegisteredAgent }
  | { readonly kind: 'cli'; readonly cli: TerminalCli }
  | { readonly kind: 'desktop'; readonly target: HandoffTarget }
  | { readonly kind: 'terminal' }
  | { readonly kind: 'none' };

export function enabledThreadAgents(
  agents: readonly RegisteredAgent[],
  overrides: EnabledOverrides,
): RegisteredAgent[] {
  return agents.filter((a) => isInAppAgentEnabled(overrides, a.source, a.id, true, a.supported));
}

export function enabledTerminalClis(
  overrides: EnabledOverrides,
  installedClis: Partial<Record<TerminalCli, boolean>>,
): TerminalCli[] {
  return TERMINAL_CLI_IDS.filter((cli) => isTerminalCliEnabled(overrides, cli, installedClis));
}

export function enabledDesktopTargets(
  overrides: EnabledOverrides,
  installStates: Partial<Record<HandoffTarget, InstallState>>,
): HandoffTarget[] {
  return VISIBLE_TARGETS.filter((t) =>
    isDesktopTargetEnabled(overrides, t.id, installStates[t.id]?.installed),
  ).map((t) => t.id);
}

export function unresolvedDesktopTargets(
  overrides: EnabledOverrides,
  installStates: Partial<Record<HandoffTarget, InstallState>>,
): HandoffTarget[] {
  return VISIBLE_TARGETS.filter(
    (t) =>
      overrides[desktopEnabledKey(t.id)] === undefined && installStates[t.id]?.installed == null,
  ).map((t) => t.id);
}

export interface LauncherSelectionInputs {
  readonly sticky: string | null;
  readonly effectiveThreadAgent: RegisteredAgent | null;
  readonly enabledClis: readonly TerminalCli[];
  readonly enabledDesktopTargets: readonly HandoffTarget[];
  readonly unresolvedDesktopTargets?: readonly HandoffTarget[];
  readonly installedClis: Partial<Record<TerminalCli, boolean>>;
  readonly terminalAvailable: boolean;
  readonly threadsAvailable: boolean;
  readonly desktopSelectable: boolean;
  readonly preferBareTerminal?: boolean;
  readonly bareTerminalFallback?: boolean;
}

export function resolveLauncherSelection(inputs: LauncherSelectionInputs): LauncherSelection {
  const {
    sticky,
    effectiveThreadAgent,
    enabledClis,
    enabledDesktopTargets: desktopTargets,
    unresolvedDesktopTargets: pendingDesktopTargets = [],
    installedClis,
    terminalAvailable,
    threadsAvailable,
    desktopSelectable,
    preferBareTerminal,
    bareTerminalFallback,
  } = inputs;

  if (preferBareTerminal && terminalAvailable) return { kind: 'terminal' };

  if (
    threadsAvailable &&
    parseStickyThreadAgent(sticky) !== null &&
    effectiveThreadAgent !== null
  ) {
    return { kind: 'thread', agent: effectiveThreadAgent };
  }
  if (terminalAvailable) {
    const cli = parseStickyCliId(sticky);
    if (cli !== null && enabledClis.includes(cli)) return { kind: 'cli', cli };
  }
  if (
    desktopSelectable &&
    sticky !== null &&
    (desktopTargets.includes(sticky as HandoffTarget) ||
      pendingDesktopTargets.includes(sticky as HandoffTarget))
  ) {
    return { kind: 'desktop', target: sticky as HandoffTarget };
  }

  if (threadsAvailable && effectiveThreadAgent !== null) {
    return { kind: 'thread', agent: effectiveThreadAgent };
  }
  if (terminalAvailable && enabledClis.length > 0) {
    const cli = enabledClis.find((c) => installedClis[c] === true) ?? enabledClis[0];
    return { kind: 'cli', cli };
  }
  if (desktopSelectable && desktopTargets.length > 0) {
    return { kind: 'desktop', target: desktopTargets[0] };
  }
  if (bareTerminalFallback && terminalAvailable) return { kind: 'terminal' };
  return { kind: 'none' };
}
