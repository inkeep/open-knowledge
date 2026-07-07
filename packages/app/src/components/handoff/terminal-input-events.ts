/**
 * Window-scoped pub/sub carrying a raw text paste into the *already-open* docked
 * terminal's active session. The editor's "Ask AI" selection affordance fires
 * this so a selection lands directly in the live shell (e.g. a running `claude`
 * TUI) when a terminal is open, skipping the bottom composer.
 *
 * Mirrors the `terminal-launch-events` idiom, but the payload is verbatim text —
 * never a `<bin> '<prompt>'` command and never a `cli` discriminant. The host
 * (`TerminalSessionsHost`) owns the PTY state, so it decides reuse-vs-fallback:
 * a live PTY → write the text into it; no terminal open → defer to the Ask-AI
 * composer (the same surface a caret-only Ask AI opens).
 */

const ACTIVE_TERMINAL_INPUT_EVENT = 'open-knowledge:active-terminal-input';

export function requestActiveTerminalInput(
  text: string,
  target: Pick<Window, 'dispatchEvent'> | EventTarget = typeof window === 'undefined'
    ? new EventTarget()
    : window,
): void {
  target.dispatchEvent(new CustomEvent<string>(ACTIVE_TERMINAL_INPUT_EVENT, { detail: text }));
}

export function subscribeToActiveTerminalInput(
  onRequest: (text: string) => void,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> | EventTarget = typeof window ===
  'undefined'
    ? new EventTarget()
    : window,
): () => void {
  const listener = (event: Event) => {
    const text = event instanceof CustomEvent ? (event as CustomEvent<string>).detail : undefined;
    if (typeof text === 'string') onRequest(text);
  };
  target.addEventListener(ACTIVE_TERMINAL_INPUT_EVENT, listener as EventListener);
  return () => target.removeEventListener(ACTIVE_TERMINAL_INPUT_EVENT, listener as EventListener);
}
