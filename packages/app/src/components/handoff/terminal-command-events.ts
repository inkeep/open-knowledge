import { shellSingleQuote, type TerminalLaunchCommand } from '@inkeep/open-knowledge-core';

export type TerminalCommandId = 'install-slidev' | 'git-status';

const TERMINAL_COMMANDS: Record<TerminalCommandId, TerminalLaunchCommand> = {
  'install-slidev': {
    executable: 'npm',
    args: ['install', '-g', '@slidev/cli', '@slidev/theme-default'],
  },
  'git-status': {
    executable: 'git',
    args: ['status'],
  },
};

function posixCommandToken(token: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(token) ? token : shellSingleQuote(token);
}

export function terminalCommandFor(id: string): string | undefined {
  if (!Object.hasOwn(TERMINAL_COMMANDS, id)) return undefined;
  const command = TERMINAL_COMMANDS[id as TerminalCommandId];
  return [command.executable, ...command.args].map(posixCommandToken).join(' ');
}

export function windowsTerminalCommandFor(id: string): TerminalLaunchCommand | undefined {
  return Object.hasOwn(TERMINAL_COMMANDS, id)
    ? TERMINAL_COMMANDS[id as TerminalCommandId]
    : undefined;
}

const TERMINAL_COMMAND_EVENT = 'open-knowledge:terminal-command';

export function requestTerminalCommand(
  id: TerminalCommandId,
  target: Pick<Window, 'dispatchEvent'> | EventTarget = typeof window === 'undefined'
    ? new EventTarget()
    : window,
): void {
  target.dispatchEvent(new CustomEvent<TerminalCommandId>(TERMINAL_COMMAND_EVENT, { detail: id }));
}

export function subscribeToTerminalCommandRequests(
  onRequest: (id: TerminalCommandId) => void,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> | EventTarget = typeof window ===
  'undefined'
    ? new EventTarget()
    : window,
): () => void {
  const handler = (event: Event) => {
    const { detail } = event as CustomEvent<string>;
    if (typeof detail === 'string' && terminalCommandFor(detail) !== undefined) {
      onRequest(detail as TerminalCommandId);
    }
  };
  target.addEventListener(TERMINAL_COMMAND_EVENT, handler);
  return () => target.removeEventListener(TERMINAL_COMMAND_EVENT, handler);
}
