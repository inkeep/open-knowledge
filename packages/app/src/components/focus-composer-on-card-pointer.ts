/**
 * Shared "click the card, focus the field" affordance for the two Ask AI
 * composers (the bottom docked composer and the empty-state create composer).
 *
 * Both wrap a ProseMirror `contentEditable` (`ComposerMentionInput`), not a
 * native `<input>`/`<textarea>`. A contentEditable focuses on click only within
 * its OWN box, and — unlike a labelable form control — a wrapping `<label>`
 * cannot forward a click into it (CSS/HTML can't move focus into a
 * contentEditable). So the standard chat-composer affordance (ChatGPT / Claude /
 * Cursor: click anywhere in the field's card to focus the input) needs this
 * pointer handler on the card.
 *
 * a11y: this is a pointer-only progressive enhancement. The card keeps passive
 * semantics (no `role`/`tabindex`) — the real control is the inner textbox,
 * which keyboard + AT users already reach via Tab and the ⌘L shortcut — so it
 * adds no interactive markup to announce and no tab-order change.
 */

import type { RefObject } from 'react';
import type { ComposerMentionInputHandle } from '@/editor/ComposerMentionInput';

// Interactive descendants that own their own click: real buttons/links, menu
// items, native form fields, and the editable itself (let the browser place the
// caret there natively). A click landing on any of these is left alone.
const INTERACTIVE_TARGET_SELECTOR =
  'button, a[href], [role="menuitem"], [role="button"], input, textarea, select, [contenteditable="true"]';

/**
 * `onMouseDown` handler for a composer card: when the press lands on the card's
 * non-interactive whitespace (its padding, the row gaps, the empty space beside
 * a short single-line input), focus the field instead of letting focus fall to
 * `<body>`. Presses on a control or inside the editable are left untouched.
 *
 * Uses `mousedown` (not `click`) and `preventDefault` so focus never visibly
 * bounces to the card first, and no text-selection drag starts on the padding.
 */
export function focusComposerInputOnCardPointer(
  event: { target: EventTarget | null; preventDefault: () => void },
  inputRef: RefObject<ComposerMentionInputHandle | null>,
): void {
  if (!(event.target instanceof HTMLElement) || event.target.closest(INTERACTIVE_TARGET_SELECTOR)) {
    return;
  }
  event.preventDefault();
  inputRef.current?.focus();
}
