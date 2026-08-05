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
 * The resolved string is baked into the PTY spawn as
 * `$SHELL -l -i -c '<cmd>; exec …'` (see TerminalPanel), not typed into a live
 * shell — so it never reaches the line editor, never lands in shell history,
 * and runs under a login+interactive shell, which is what makes a global `npm`
 * install resolve at all from a GUI-launched app.
 */

/** Commands a UI surface may ask the terminal to run. Closed by design. */
export type TerminalCommandId = 'install-slidev';

/**
 * The command each id maps to.
 *
 * `@slidev/theme-default` is not optional padding: Slidev themes ship as
 * separate packages, OpenKnowledge spawns Slidev non-interactively so it cannot
 * prompt to fetch a missing one, and a deck declaring the default theme exits
 * on boot without it. Installing only the CLI leaves the user with a Slides
 * action that opens nothing.
 */
const TERMINAL_COMMANDS: Record<TerminalCommandId, string> = {
  'install-slidev': 'npm install -g @slidev/cli @slidev/theme-default',
};

/** The shell text for `id`, or undefined when the id is not in the union (a
 *  stale event from an older renderer, or a hand-fired one). */
export function terminalCommandFor(id: string): string | undefined {
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
