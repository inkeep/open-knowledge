/**
 * The single source of truth for "what does an agent-launcher's primary button
 * launch, and which rows are visible?" — shared by every primary-button surface
 * (footer Ask composer, empty-state Create composer, sessions-dock New button).
 *
 * Before this, each surface re-derived selection its own way: one used the
 * enabled-aware effective default, another read the raw default with a
 * mount-time snapshot, a third forced a Claude CLI fallback that ignored the
 * enable/disable toggles. That divergence is exactly what let disabling an agent
 * fix one surface and leave another showing it. This module makes every category
 * (in-app agent / terminal CLI / desktop app) respect the Configure-agents
 * toggles UNIFORMLY, so a disabled thing is never the selection anywhere.
 *
 * Pure + host-agnostic: callers feed the reactive store + probe values, so React
 * re-derives selection every render (no stale snapshots).
 */

import type { HandoffTarget, TerminalCli } from '@inkeep/open-knowledge-core';
import { TERMINAL_CLI_IDS } from '@inkeep/open-knowledge-core';
import { VISIBLE_TARGETS } from '@/lib/handoff/targets';
import { parseStickyCliId, parseStickyThreadAgent } from '../unified-agent-store';
import {
  isDesktopTargetEnabled,
  isInAppAgentEnabled,
  isTerminalCliEnabled,
} from './agent-visibility';
import type { EnabledOverrides } from './enabled-agents';
import type { RegisteredAgent } from './registered-agents';

/** What a primary launcher button launches. `none` = nothing enabled to launch. */
export type LauncherSelection =
  | { readonly kind: 'thread'; readonly agent: RegisteredAgent }
  | { readonly kind: 'cli'; readonly cli: TerminalCli }
  | { readonly kind: 'desktop'; readonly target: HandoffTarget }
  | { readonly kind: 'terminal' } // bare shell — sessions dock only
  | { readonly kind: 'none' };

/** Registered in-app agents the user has ENABLED (and that are supported here). */
export function enabledThreadAgents(
  agents: readonly RegisteredAgent[],
  overrides: EnabledOverrides,
): RegisteredAgent[] {
  return agents.filter((a) => isInAppAgentEnabled(overrides, a.source, a.id, true, a.supported));
}

/**
 * Terminal CLIs the user has ENABLED, in launch-priority order. `isTerminalCliEnabled`
 * already folds in install detection (fail-open: shown unless probed absent).
 */
export function enabledTerminalClis(
  overrides: EnabledOverrides,
  installedClis: Partial<Record<TerminalCli, boolean>>,
): TerminalCli[] {
  return TERMINAL_CLI_IDS.filter((cli) => isTerminalCliEnabled(overrides, cli, installedClis));
}

/** Desktop targets the user has ENABLED (opt-in; independent of install state). */
export function enabledDesktopTargets(overrides: EnabledOverrides): HandoffTarget[] {
  return VISIBLE_TARGETS.filter((t) => isDesktopTargetEnabled(overrides, t.id)).map((t) => t.id);
}

export interface LauncherSelectionInputs {
  /** Raw sticky/explicit pick (unified-agent-store id), or null. */
  readonly sticky: string | null;
  /** The in-app agent the primary leads with: `pickEffectiveDefaultAgent` over the
   *  ENABLED set (the registered default when still enabled, else the first
   *  enabled one). Null when no in-app agent is enabled. */
  readonly effectiveThreadAgent: RegisteredAgent | null;
  /** Enabled terminal CLIs, priority order ({@link enabledTerminalClis}). */
  readonly enabledClis: readonly TerminalCli[];
  /** Enabled desktop targets ({@link enabledDesktopTargets}). */
  readonly enabledDesktopTargets: readonly HandoffTarget[];
  /** Install map — the default CLI prefers an installed enabled CLI over an
   *  unknown-install one. */
  readonly installedClis: Partial<Record<TerminalCli, boolean>>;
  /** The surface can launch terminal CLIs / a bare shell (desktop bridge). */
  readonly terminalAvailable: boolean;
  /** The surface can launch in-app agent threads. */
  readonly threadsAvailable: boolean;
  /** The surface offers Desktop app rows as picks (composers do; the dock doesn't). */
  readonly desktopSelectable: boolean;
  /** Remembered bare-terminal pick (dock only). */
  readonly preferBareTerminal?: boolean;
  /** Final fallback is a bare terminal (dock) rather than `none` (composers). */
  readonly bareTerminalFallback?: boolean;
}

/**
 * Resolve the primary button's effective selection. A remembered pick is honored
 * only when its family is available AND the thing is still ENABLED; a disabled
 * (or vanished) pick degrades to the zero-config default. The default precedence
 * is uniform: an enabled in-app agent, else an enabled CLI, else — on surfaces
 * that offer Desktop rows — an enabled Desktop app, else a bare terminal (dock) /
 * nothing (composers). Desktop only defaults when it is the sole enabled family;
 * it never outranks an in-app agent or CLI.
 */
export function resolveLauncherSelection(inputs: LauncherSelectionInputs): LauncherSelection {
  const {
    sticky,
    effectiveThreadAgent,
    enabledClis,
    enabledDesktopTargets: desktopTargets,
    installedClis,
    terminalAvailable,
    threadsAvailable,
    desktopSelectable,
    preferBareTerminal,
    bareTerminalFallback,
  } = inputs;

  if (preferBareTerminal && terminalAvailable) return { kind: 'terminal' };

  // A remembered pick — honored only if still enabled + launchable here.
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
  if (desktopSelectable && sticky !== null && desktopTargets.includes(sticky as HandoffTarget)) {
    return { kind: 'desktop', target: sticky as HandoffTarget };
  }

  // Zero-config default precedence (thread-first for consistency across surfaces).
  if (threadsAvailable && effectiveThreadAgent !== null) {
    return { kind: 'thread', agent: effectiveThreadAgent };
  }
  if (terminalAvailable && enabledClis.length > 0) {
    const cli = enabledClis.find((c) => installedClis[c] === true) ?? enabledClis[0];
    return { kind: 'cli', cli };
  }
  // An enabled Desktop app is a valid default only when nothing higher-priority
  // is enabled — the user opted it in, so defaulting to it beats stranding the
  // primary on a disabled Create button with no picker to reach it. It never
  // outranks an in-app agent or CLI, and a fresh install (in-app seeded, Desktop
  // off) never reaches here.
  if (desktopSelectable && desktopTargets.length > 0) {
    return { kind: 'desktop', target: desktopTargets[0] };
  }
  if (bareTerminalFallback && terminalAvailable) return { kind: 'terminal' };
  return { kind: 'none' };
}
