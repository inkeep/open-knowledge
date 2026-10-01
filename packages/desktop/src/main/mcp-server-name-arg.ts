import { currentMcpServerName } from '@inkeep/open-knowledge-core';
import { MCP_SERVER_NAME_ARG_NAME } from '../shared/ok-desktop-argv.ts';

export function withMcpServerNameArg(args: readonly string[]): string[] {
  return [...args, `--ok-${MCP_SERVER_NAME_ARG_NAME}=${currentMcpServerName()}`];
}
