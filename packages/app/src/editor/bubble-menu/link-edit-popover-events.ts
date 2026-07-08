/**
 * Window-scoped pub/sub that asks the bubble menu's link popover to open its
 * URL input and take focus. The ⌘K claim in `LinkEditPopover`'s capture
 * listener fires this instead of flipping component state directly so the
 * open+focus implementation lives in exactly one place (the component's
 * subscriber), and any future caller outside the bubble-menu subtree can
 * reuse it without a ref into it.
 *
 * Mirrors the `ask-ai-composer-events` idiom. The signal is intent-only — no
 * payload; the popover derives its initial URL from the live selection. The
 * subscriber gates on its own active-editor flag, so pooled hidden editors
 * ignore broadcasts aimed at the active one.
 */

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
