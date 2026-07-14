/**
 * Shared display data for the docked-terminal CLI launch rows, so every
 * "Open with AI" / New-chat surface (header popover + the two right-click
 * submenus + the empty-state create composer + the composer "Ask" split button +
 * the tab-strip New-chat dropdown) renders the CLIs in the same order with the
 * same brand icon and accessible name, gated the same way by {@link visibleTerminalClis}.
 */
import {
  type HandoffTarget,
  TERMINAL_CLI_IDS,
  TERMINAL_CLIS,
  type TerminalCli,
} from '@inkeep/open-knowledge-core';

/** CLIs shown under the "Terminal" section, in launch order — the full set,
 *  before PATH-detection gating. Callers pass the installed-CLI map through
 *  {@link visibleTerminalClis} to drop CLIs that aren't installed. */
export const VISIBLE_CLIS: readonly TerminalCli[] = TERMINAL_CLI_IDS;

/** Terminal CLIs surfaced as launch rows even when NOT detected on PATH. Claude
 *  is the install-nudge anchor: it's the default-CLI fallback (`resolveDefaultCli`)
 *  and has a "Get Claude" missing-CLI banner, so keeping its row is a discoverable
 *  install affordance rather than a dead end. Every other CLI is offered only once
 *  detected — a niche CLI (e.g. Antigravity) shouldn't clutter the menu for users
 *  who don't have it. */
const ALWAYS_VISIBLE_CLIS: ReadonlySet<TerminalCli> = new Set<TerminalCli>(['claude']);

/**
 * The launch-row CLIs to show given the PATH-detection map, in
 * {@link TERMINAL_CLI_IDS} launch order. Fails OPEN: a CLI is hidden only when
 * the probe positively reports it absent (`installed[cli] === false`). Shown
 * otherwise — always-visible anchors (Claude), `keep` (the current pick), any
 * detected CLI, and — critically — any CLI whose state is still UNKNOWN.
 *
 * "Unknown" is `installed[cli] === undefined`. A resolved probe map is complete
 * (every CLI keyed true/false — see `resolveCliInstalledMap`), so an undefined
 * entry means the probe hasn't resolved yet, failed, or the desktop bridge is
 * too old to expose it. Hiding on unknown would make a probe failure or a
 * renderer/main version skew silently drop genuinely-installed CLIs from every
 * launch surface for the whole session; failing open keeps them launchable (the
 * pre-gating behavior) and lets the row settle once the probe confirms absence.
 *
 * @param keep the current pick (sticky/default CLI) — never hidden, even when
 *   probed absent, so a picker's dropdown always contains its own selected row.
 */
export function visibleTerminalClis(
  installed: Partial<Record<TerminalCli, boolean>>,
  keep?: TerminalCli | null,
): readonly TerminalCli[] {
  return TERMINAL_CLI_IDS.filter(
    (cli) => ALWAYS_VISIBLE_CLIS.has(cli) || cli === keep || installed[cli] !== false,
  );
}

/** CLI id → the handoff target id whose brand icon `TargetIcon` renders. Reads
 *  the single source of truth on the registry (shared with prompt composition)
 *  rather than a parallel local map. */
export function cliIconTargetId(cli: TerminalCli): HandoffTarget {
  return TERMINAL_CLIS[cli].handoffTarget;
}
