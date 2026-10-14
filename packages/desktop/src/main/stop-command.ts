import { currentCliCommandName } from '@inkeep/open-knowledge-core';

function posixQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function windowsQuote(value: string): string {
  return `"${value.replace(/(\\+)$/, '$1$1')}"`;
}

export function quoteStopCommandPath(projectPath: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? windowsQuote(projectPath) : posixQuote(projectPath);
}

export function stopCommandLine(
  projectPath: string,
  platform: NodeJS.Platform,
  opts: { readonly force?: boolean } = {},
): string {
  const force = opts.force === true ? ' --force' : '';
  return `${currentCliCommandName()} stop${force} ${quoteStopCommandPath(projectPath, platform)}`;
}
