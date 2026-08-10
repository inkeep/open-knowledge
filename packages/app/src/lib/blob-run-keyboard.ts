import { isOverlayLayerOpen } from '@/lib/overlay-layers';

/**
 * Controls that own the keyboard while focused. The game's key handlers defer
 * to anything in here rather than stealing Space from it.
 */
const INTERACTIVE_FOCUS_SELECTOR =
  'button, a[href], input, textarea, select, [contenteditable="true"], [role="button"], [role="menuitem"]';

export function focusIsOnAControl(): boolean {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement;
  if (!active || active === document.body) return false;
  return active instanceof Element && active.matches(INTERACTIVE_FOCUS_SELECTOR);
}

/**
 * Whether the game may act on an app-global key right now.
 *
 * Two independent reasons to stand down, and both matter:
 *
 *  - An overlay layer owns the keyboard. This is the codebase's existing rule
 *    for app-global listeners (`isOverlayLayerOpen`), and the error screens
 *    that host the game can open a bug-report dialog directly on top of it.
 *  - A control has focus, so Space is its activation key.
 *
 * `allowWhileFocused` exists for keys no control treats as activation (the
 * arrows). Those may still act with a button focused, but never under an
 * overlay.
 */
export function gameMayHandleKey(options: { allowWhileFocused?: boolean } = {}): boolean {
  if (isOverlayLayerOpen()) return false;
  if (options.allowWhileFocused) return true;
  return !focusIsOnAControl();
}
