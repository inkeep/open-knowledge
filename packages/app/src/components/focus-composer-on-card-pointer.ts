import type { RefObject } from 'react';

const INTERACTIVE_TARGET_SELECTOR =
  'button, a[href], [role="menuitem"], [role="button"], input, textarea, select, [contenteditable="true"]';

export function focusComposerInputOnCardPointer(
  event: {
    target: EventTarget | null;
    currentTarget: EventTarget | null;
    preventDefault: () => void;
  },
  inputRef: RefObject<{ focus: () => void; focusEnd?: () => void } | null>,
): void {
  if (!(event.target instanceof HTMLElement)) return;
  if (
    !(event.currentTarget instanceof HTMLElement) ||
    !event.currentTarget.contains(event.target)
  ) {
    return;
  }
  if (event.target.closest(INTERACTIVE_TARGET_SELECTOR)) return;
  event.preventDefault();
  const handle = inputRef.current;
  if (handle === null) return;
  if (handle.focusEnd !== undefined) handle.focusEnd();
  else handle.focus();
}
