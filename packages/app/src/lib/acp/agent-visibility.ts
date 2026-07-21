/**
 * Effective enabled-state per agent category — the single source of the
 * per-category defaults, so the Settings toggle list and all three launcher
 * dropdowns resolve visibility identically.
 *
 * Enablement = the user's explicit override (from `enabled-agents.ts`) when
 * present, else the category default computed from the runtime signal the
 * caller supplies:
 *   - In app   → registered (enabling registers; nothing installs to detect)
 *   - Terminal → fail-open: shown unless positively absent on PATH
 *                (`installed[cli] === false`); an unresolved probe still shows
 *   - Desktop  → off (opt-in; the user enables desktop hand-offs in Settings)
 */

import type { HandoffTarget, TerminalCli } from '@inkeep/open-knowledge-core';
import {
  desktopEnabledKey,
  type EnabledOverrides,
  inAppEnabledKey,
  resolveEnabled,
  terminalEnabledKey,
} from './enabled-agents';

/**
 * In-app agent: default enabled when the user has registered it. An agent with
 * no launchable build for this host (`supported === false`) is force-disabled —
 * it can't be turned on in Settings and never appears in a launcher, so the
 * Settings toggle and the menus can't disagree. `supported === undefined` means
 * the catalog hasn't hydrated yet: fail open until we know (matches the
 * detection-pending stance used elsewhere), converging once the catalog loads.
 */
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

/**
 * Terminal CLI: default fail-open — shown unless the PATH probe positively
 * reports the CLI absent (`installed[cli] === false`). An unresolved probe
 * (`undefined`, e.g. the cold-start window) still shows the row, so a probe miss
 * never silently drops an installed CLI. Claude is not special-cased visible: a
 * probed-absent Claude CLI hides like any other. The user can still re-enable it
 * in Settings, and the install-nudge launch default in `resolveDefaultCli` is a
 * separate last-resort path, not a visibility rule.
 */
export function isTerminalCliEnabled(
  overrides: EnabledOverrides,
  cli: TerminalCli,
  installed: Partial<Record<TerminalCli, boolean>>,
): boolean {
  return resolveEnabled(overrides[terminalEnabledKey(cli)], installed[cli] !== false);
}

/**
 * Desktop target: default OFF. Desktop hand-offs are opt-in — the user enables
 * the apps they want in Settings → Configure agents. Install detection only
 * drives the "Not installed" hint in Settings, not the default.
 */
export function isDesktopTargetEnabled(
  overrides: EnabledOverrides,
  targetId: HandoffTarget,
): boolean {
  return resolveEnabled(overrides[desktopEnabledKey(targetId)], false);
}
