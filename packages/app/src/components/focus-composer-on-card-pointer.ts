/**
 * Shared "click the card, focus the field" affordance for the composer cards:
 * the two Ask AI composers (ProseMirror `ComposerMentionInput` contentEditable)
 * and the agent-thread composer (native `<textarea>`).
 *
 * A contentEditable focuses on click only within its OWN box, and — unlike a
 * labelable form control — a wrapping `<label>` cannot forward a click into it,
 * so the standard chat-composer affordance (ChatGPT / Claude / Cursor: click
 * anywhere in the field's card to focus the input) needs this pointer handler.
 * The agent-thread composer's chrome (wrapper padding, the whitespace in the
 * action bar between the settings menu and the send button) isn't wrapped in a
 * label either, so it reuses the same handler against its textarea ref.
 *
 * a11y: this is a pointer-only progressive enhancement. The card keeps passive
 * semantics (no `role`/`tabindex`) — the real control is the inner textbox,
 * which keyboard + AT users already reach via Tab and the ⌘L shortcut — so it
 * adds no interactive markup to announce and no tab-order change.
 */

import type { RefObject } from 'react';

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
  // Any focusable input handle — the ProseMirror `ComposerMentionInputHandle`
  // (Ask AI composers) or a native `HTMLTextAreaElement` (the agent-thread
  // composer). Both expose `focus()`.
  inputRef: RefObject<{ focus: () => void } | null>,
): void {
  if (!(event.target instanceof HTMLElement) || event.target.closest(INTERACTIVE_TARGET_SELECTOR)) {
    return;
  }
  event.preventDefault();
  inputRef.current?.focus();
}
