/**
 * Window-scoped pub/sub carrying a raw text paste to the sessions dock's
 * preferred AI. The editor's "Ask AI" affordances (selection bubble, code block,
 * Problems panel) and the ⌘J / ⇧⌘J selection sends fire this so a passage lands
 * wherever the user's preferred AI actually is.
 *
 * Mirrors the `terminal-launch-events` idiom, but the payload is verbatim text —
 * never a `<bin> '<prompt>'` command and never a `cli` discriminant. The host
 * (`TerminalSessionsHost`) owns both the PTY state AND the preferred-AI
 * resolution, so it alone decides reuse-vs-launch and which family to launch
 * into: a live session → write into it; nothing open → launch whatever
 * `resolveLauncherSelection` names. Senders deliberately carry no agent opinion,
 * so the host's preferred-AI resolution is the single source of that decision.
 *
 * `newTab` distinguishes ⇧⌘J ("always a fresh session") from ⌘J ("continue where
 * I am when that makes sense"). It is a request, not a guarantee — the host still
 * degrades per what is enabled and available.
 */

const ACTIVE_TERMINAL_INPUT_EVENT = 'open-knowledge:active-terminal-input';

export interface ActiveTerminalInputDetail {
  readonly text: string;
  /** Force a fresh session rather than reusing the active one. */
  readonly newTab: boolean;
  /**
   * The text is a complete instruction, so RUN it when starting a fresh session
   * (the Ask AI surfaces). Unset means it is raw material to write and leave
   * unsent (the ⌘J/⇧⌘J selection sends).
   *
   * Only the fresh-session branch honors this — reusing a live session writes
   * without submitting, on both families: a launch intent's `prompt` runs while
   * its `stagePaste` waits, and the thread path mirrors that. The reuse write
   * goes in without a trailing carriage return; the host keeps it off a bare
   * shell (where each `\n` would submit a line) by reusing only a live CLI
   * session, never any live PTY.
   */
  readonly submit: boolean;
}

export function requestActiveTerminalInput(
  text: string,
  options?: { newTab?: boolean; submit?: boolean },
  target: Pick<Window, 'dispatchEvent'> | EventTarget = typeof window === 'undefined'
    ? new EventTarget()
    : window,
): void {
  target.dispatchEvent(
    new CustomEvent<ActiveTerminalInputDetail>(ACTIVE_TERMINAL_INPUT_EVENT, {
      detail: { text, newTab: options?.newTab === true, submit: options?.submit === true },
    }),
  );
}

export function subscribeToActiveTerminalInput(
  onRequest: (detail: ActiveTerminalInputDetail) => void,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> | EventTarget = typeof window ===
  'undefined'
    ? new EventTarget()
    : window,
): () => void {
  const listener = (event: Event) => {
    const detail =
      event instanceof CustomEvent
        ? (event as CustomEvent<ActiveTerminalInputDetail>).detail
        : undefined;
    if (detail !== undefined && typeof detail.text === 'string') {
      onRequest({
        text: detail.text,
        newTab: detail.newTab === true,
        submit: detail.submit === true,
      });
    }
  };
  target.addEventListener(ACTIVE_TERMINAL_INPUT_EVENT, listener as EventListener);
  return () => target.removeEventListener(ACTIVE_TERMINAL_INPUT_EVENT, listener as EventListener);
}
