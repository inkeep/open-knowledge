import {
  type HandoffTarget,
  TERMINAL_CLI_IDS,
  TERMINAL_CLIS,
  type TerminalCli,
} from '@inkeep/open-knowledge-core';

export const VISIBLE_CLIS: readonly TerminalCli[] = TERMINAL_CLI_IDS;

export function cliIconTargetId(cli: TerminalCli): HandoffTarget {
  return TERMINAL_CLIS[cli].handoffTarget;
}
