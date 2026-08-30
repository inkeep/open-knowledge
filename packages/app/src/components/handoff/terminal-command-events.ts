/**
 * Window-scoped pub/sub that carries a "run this in the terminal" request from
 * a settings panel to the docked terminal, whose open-state lives in
 * EditorPane. Same idiom as `terminal-launch-events`, deliberately kept
 * separate from it.
 *
 * **This channel carries an id, never a command.** Its sibling
 * `terminal-launch-events` states that it never carries an executable command —
 * only a prompt the session wraps in a fixed `<bin> '<prompt>'`. That boundary
 * is worth keeping, so this channel carries a member of a closed union and the
 * consumer maps it to a constant here. Nothing a caller passes can become
 * shell text: an id that is not in {@link TERMINAL_COMMANDS} resolves to
 * nothing and the request is dropped.
 *
 * The resolved payload is baked into the PTY spawn (a POSIX command string or
 * structured Windows argv), not typed into a live shell, so it never reaches
 * the line editor or persistent history.
 */

import { shellSingleQuote, type TerminalLaunchCommand } from '@inkeep/open-knowledge-core';

/** Commands a UI surface may ask the terminal to run. Closed by design. */
export type TerminalCommandId = 'install-slidev' | 'git-status';

/**
 * The command each id maps to.
 *
 * `@slidev/theme-default` is not optional padding: Slidev themes ship as
 * separate packages, OpenKnowledge spawns Slidev non-interactively so it cannot
 * prompt to fetch a missing one, and a deck declaring the default theme exits
 * on boot without it. Installing only the CLI leaves the user with a Slides
 * action that opens nothing.
 */
const TERMINAL_COMMANDS: Record<TerminalCommandId, TerminalLaunchCommand> = {
  'install-slidev': {
    executable: 'npm',
    args: ['install', '-g', '@slidev/cli', '@slidev/theme-default'],
  },
  // The sync panel's "Resolve in terminal": land the user in the project with
  // the state of the working tree already printed, rather than in a bare shell
  // they have to orient themselves in. Read-only by construction — resolving is
  // theirs to drive, and a constant keeps the closed-union contract (no path,
  // no branch name, nothing interpolated into shell text).
  'git-status': {
    executable: 'git',
    args: ['status'],
  },
};

function posixCommandToken(token: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(token) ? token : shellSingleQuote(token);
}

/** The shell text for `id`, or undefined when the id is not in the union (a
 *  stale event from an older renderer, or a hand-fired one). */
export function terminalCommandFor(id: string): string | undefined {
  if (!Object.hasOwn(TERMINAL_COMMANDS, id)) return undefined;
  const command = TERMINAL_COMMANDS[id as TerminalCommandId];
  return [command.executable, ...command.args].map(posixCommandToken).join(' ');
}

/** Structured Windows counterpart; shell-family composition stays in the PTY host. */
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
    // Drop anything outside the union rather than forwarding it — the consumer
    // turns this into shell text, so an unknown id must never reach it.
    if (typeof detail === 'string' && terminalCommandFor(detail) !== undefined) {
      onRequest(detail as TerminalCommandId);
    }
  };
  target.addEventListener(TERMINAL_COMMAND_EVENT, handler);
  return () => target.removeEventListener(TERMINAL_COMMAND_EVENT, handler);
}
