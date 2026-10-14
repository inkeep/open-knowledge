import { currentCliCommandName } from '@inkeep/open-knowledge-core';
import { CLI_COMMAND_NAME_ARG_NAME } from '../shared/ok-desktop-argv.ts';

export function withCliCommandNameArg(args: readonly string[]): string[] {
  return [...args, `--ok-${CLI_COMMAND_NAME_ARG_NAME}=${currentCliCommandName()}`];
}
