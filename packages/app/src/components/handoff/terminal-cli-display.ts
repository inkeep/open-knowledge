/**
 * Shared display data for the docked-terminal CLI launch rows, so every
 * "Open with AI" / New-chat surface (header popover + the two right-click
 * submenus + the empty-state create composer + the composer "Ask" split button +
 * the tab-strip New-chat dropdown) renders the CLIs in the same order with the
 * same brand icon and accessible name, gated the same way by `isTerminalCliEnabled`.
 */
import {
  type HandoffTarget,
  TERMINAL_CLI_IDS,
  TERMINAL_CLIS,
  type TerminalCli,
} from '@inkeep/open-knowledge-core';

/** CLIs shown under the "Terminal" section, in launch order — the full set,
 *  before enablement gating. Launcher surfaces filter this through
 *  `isTerminalCliEnabled` (in `agent-visibility.ts`) to drop CLIs the probe
 *  reports absent. */
export const VISIBLE_CLIS: readonly TerminalCli[] = TERMINAL_CLI_IDS;

/** CLI id → the handoff target id whose brand icon `TargetIcon` renders. Reads
 *  the single source of truth on the registry (shared with prompt composition)
 *  rather than a parallel local map. */
export function cliIconTargetId(cli: TerminalCli): HandoffTarget {
  return TERMINAL_CLIS[cli].handoffTarget;
}
