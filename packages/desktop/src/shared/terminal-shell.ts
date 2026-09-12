import { shellSingleQuote } from '@inkeep/open-knowledge-core';

export function interactiveShellArgs(platform: NodeJS.Platform): readonly string[] {
  return platform === 'linux' ? ['-i'] : ['-l', '-i'];
}

function fishSingleQuote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

const POSIX_SHELL_NAMES = new Set(['ash', 'bash', 'dash', 'ksh', 'ksh93', 'mksh', 'sh', 'zsh']);

export type ShellCommandFamily = 'posix' | 'fish' | 'fallback';

export function shellCommandFamily(shell: string): ShellCommandFamily {
  const shellName = shell.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase() ?? '';
  if (shellName === 'fish') return 'fish';
  return POSIX_SHELL_NAMES.has(shellName) ? 'posix' : 'fallback';
}

export function quoteShellArg(shell: string, value: string): string {
  return shellCommandFamily(shell) === 'fish' ? fishSingleQuote(value) : shellSingleQuote(value);
}

function posixReassert(managedBinDirs: readonly string[], command: string): string {
  const guards = [...managedBinDirs]
    .reverse()
    .map((dir) => {
      const quoted = shellSingleQuote(dir);
      return `case ":$PATH:" in *:${quoted}:*) ;; *) PATH=${quoted}"\${PATH:+:$PATH}" ;; esac`;
    })
    .join('; ');
  return `${guards}; export PATH; ${command}`;
}

function fishReassert(managedBinDirs: readonly string[], command: string): string {
  const guards = [...managedBinDirs]
    .reverse()
    .map((dir) => {
      const quoted = fishSingleQuote(dir);
      return `if not contains ${quoted} $PATH; set -gx PATH ${quoted} $PATH; end`;
    })
    .join('; ');
  return `${guards}; ${command}`;
}

export function commandWithManagedPath(
  shell: string,
  command: string,
  managedBinDirs: readonly string[],
): string {
  if (managedBinDirs.length === 0) return command;
  const family = shellCommandFamily(shell);
  if (family === 'fish') return fishReassert(managedBinDirs, command);
  const inner = posixReassert(managedBinDirs, command);
  return family === 'posix' ? inner : `exec /bin/sh -c ${shellSingleQuote(inner)}`;
}
