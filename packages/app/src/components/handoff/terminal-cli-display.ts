/**
 * Shared display data for the docked-terminal CLI launch rows, so all four
 * "Open with AI" surfaces (header popover + the two right-click submenus + the
 * empty-state create composer) render the same set of CLIs in the same order
 * with the same brand icon and accessible name.
 */
import {
  type HandoffTarget,
  TERMINAL_CLI_IDS,
  TERMINAL_CLIS,
  type TerminalCli,
} from '@inkeep/open-knowledge-core';

/** CLIs shown under the "Terminal" section, in launch order. */
export const VISIBLE_CLIS: readonly TerminalCli[] = TERMINAL_CLI_IDS;

/** CLI id → the handoff target id whose brand icon `TargetIcon` renders. Reads
 *  the single source of truth on the registry (shared with prompt composition)
 *  rather than a parallel local map. */
export function cliIconTargetId(cli: TerminalCli): HandoffTarget {
  return TERMINAL_CLIS[cli].handoffTarget;
}
