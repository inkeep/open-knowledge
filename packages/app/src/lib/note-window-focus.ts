/**
 * Initial keyboard focus for a popped-out note window.
 *
 * A note window opens showing one document and nothing else focusable, so
 * without this the caret lands on `document.body` and the first keystroke goes
 * nowhere. The workspace window has a sidebar and a tab strip to focus into and
 * deliberately does NOT autofocus the editor, so this is note-only.
 *
 * The claim is one-shot per WINDOW, not per editor mount. Editors mount and
 * remount constantly here — the Activity pool hides and reveals entries, and a
 * mode switch tears down one editor surface and builds the other — and focusing
 * on every mount would yank the caret back mid-session, including out of the
 * property panel the user just clicked into. Whichever surface mounts first
 * (WYSIWYG or source, per the persisted editor mode) takes the claim; the other
 * finds it spent.
 */

import { isNoteWindow } from '@/lib/note-window-mode';

let claimed = false;

/**
 * `true` at most once per note window, for the caller that should take focus.
 * Always `false` in every other window mode.
 */
export function claimNoteWindowInitialFocus(): boolean {
  if (claimed || !isNoteWindow()) return false;
  claimed = true;
  return true;
}

/** Test-only: forget the claim so each case starts from a fresh window. */
export function __resetNoteWindowFocusClaimForTests(): void {
  claimed = false;
}
