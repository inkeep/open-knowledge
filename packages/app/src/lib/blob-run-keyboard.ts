import { isOverlayLayerOpen } from '@/lib/overlay-layers';

const INTERACTIVE_FOCUS_SELECTOR =
  'button, a[href], input, textarea, select, [contenteditable="true"], [role="button"], [role="menuitem"]';

export function focusIsOnAControl(): boolean {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement;
  if (!active || active === document.body) return false;
  return active instanceof Element && active.matches(INTERACTIVE_FOCUS_SELECTOR);
}

export function gameMayHandleKey(options: { allowWhileFocused?: boolean } = {}): boolean {
  if (isOverlayLayerOpen()) return false;
  if (options.allowWhileFocused) return true;
  return !focusIsOnAControl();
}
