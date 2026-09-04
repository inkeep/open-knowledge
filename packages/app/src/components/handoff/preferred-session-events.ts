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
