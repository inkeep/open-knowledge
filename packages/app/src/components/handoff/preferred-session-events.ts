const PREFERRED_SESSION_EVENT = 'open-knowledge:new-preferred-session';

export function requestPreferredSession(
  target: Pick<Window, 'dispatchEvent'> | EventTarget = typeof window === 'undefined'
    ? new EventTarget()
    : window,
): boolean {
  return !target.dispatchEvent(new CustomEvent(PREFERRED_SESSION_EVENT, { cancelable: true }));
}

export function subscribeToPreferredSessionRequests(
  onRequest: () => void,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> | EventTarget = typeof window ===
  'undefined'
    ? new EventTarget()
    : window,
  matches: () => boolean = () => true,
): () => void {
  const listener = (event: Event) => {
    if (event.defaultPrevented || !matches()) return;
    event.preventDefault();
    onRequest();
  };
  target.addEventListener(PREFERRED_SESSION_EVENT, listener);
  return () => target.removeEventListener(PREFERRED_SESSION_EVENT, listener);
}
