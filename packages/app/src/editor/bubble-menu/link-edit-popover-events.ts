const OPEN_LINK_EDIT_POPOVER_EVENT = 'open-knowledge:open-link-edit-popover';

export function emitOpenLinkEditPopover(
  target: Pick<Window, 'dispatchEvent'> | EventTarget = typeof window === 'undefined'
    ? new EventTarget()
    : window,
): void {
  target.dispatchEvent(new CustomEvent(OPEN_LINK_EDIT_POPOVER_EVENT));
}

export function subscribeToOpenLinkEditPopover(
  onRequest: () => void,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> | EventTarget = typeof window ===
  'undefined'
    ? new EventTarget()
    : window,
): () => void {
  const listener = () => onRequest();
  target.addEventListener(OPEN_LINK_EDIT_POPOVER_EVENT, listener as EventListener);
  return () => target.removeEventListener(OPEN_LINK_EDIT_POPOVER_EVENT, listener as EventListener);
}
