/**
 * Window-scoped pub/sub for "open a new session with my preferred AI" — the
 * promptless sibling of `terminal-input-events`.
 *
 * ⇧⌘J with no selection fires this. It carries no payload on purpose: which AI
 * opens is `SessionsHost`'s call (the same `resolveLauncherSelection` its New
 * split-button primary uses), not the caller's. Resolving in the caller is what
 * made ⇧⌘J always open a Claude CLI — the pane could only see the CLI slice of
 * the preference.
 *
 * Both docked hosts subscribe. They resolve the preferred AI from the same
 * global inputs and each claims only the kinds it owns, so exactly one panel
 * opens a session and reveals itself.
 *
 * Distinct from the Terminal menu's `new-terminal` action, which is explicitly a
 * bare shell and stays that way.
 */

const PREFERRED_SESSION_EVENT = 'open-knowledge:new-preferred-session';

export function requestPreferredSession(
  target: Pick<Window, 'dispatchEvent'> | EventTarget = typeof window === 'undefined'
    ? new EventTarget()
    : window,
): void {
  target.dispatchEvent(new CustomEvent(PREFERRED_SESSION_EVENT));
}

export function subscribeToPreferredSessionRequests(
  onRequest: () => void,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> | EventTarget = typeof window ===
  'undefined'
    ? new EventTarget()
    : window,
): () => void {
  const listener = () => onRequest();
  target.addEventListener(PREFERRED_SESSION_EVENT, listener);
  return () => target.removeEventListener(PREFERRED_SESSION_EVENT, listener);
}
