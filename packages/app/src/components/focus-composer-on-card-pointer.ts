/**
 * Shared "click the card, focus the field" affordance for the composer cards:
 * the two Ask AI composers and the agent-thread composer (all ProseMirror
 * `ComposerMentionInput` contentEditables).
 *
 * A contentEditable focuses on click only within its OWN box, and — unlike a
 * labelable form control — a wrapping `<label>` cannot forward a click into it,
 * so the standard chat-composer affordance (ChatGPT / Claude / Cursor: click
 * anywhere in the field's card to focus the input) needs this pointer handler
 * for the card's chrome (wrapper padding, the whitespace in an action bar
 * between the settings menu and the send button).
 *
 * a11y: this is a pointer-only progressive enhancement. The card keeps passive
 * semantics (no `role`/`tabindex`) — the real control is the inner textbox,
 * which keyboard + AT users already reach via Tab and the ⇧⌘L shortcut — so it
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
  event: {
    target: EventTarget | null;
    currentTarget: EventTarget | null;
    preventDefault: () => void;
  },
  // Any focusable input handle — in practice the ProseMirror
  // `ComposerMentionInputHandle`; typed structurally so any `focus()`-bearing
  // handle works.
  inputRef: RefObject<{ focus: () => void } | null>,
): void {
  if (!(event.target instanceof HTMLElement)) return;
  // React portals bubble synthetic events along the REACT tree, not the DOM
  // tree, so a press inside a menu/popover opened from a control on this card
  // arrives here even though the floater renders under `document.body`. Only a
  // press that physically lands in the card is the card's to handle: claiming
  // the others stole focus out of the open menu, dismissing it before the row's
  // `click` landed. The role list below cannot stand in for this — menu rows
  // carry `menuitemradio` / `menuitemcheckbox`, and each new floater brings
  // roles of its own.
  if (
    !(event.currentTarget instanceof HTMLElement) ||
    !event.currentTarget.contains(event.target)
  ) {
    return;
  }
  if (event.target.closest(INTERACTIVE_TARGET_SELECTOR)) return;
  event.preventDefault();
  inputRef.current?.focus();
}
