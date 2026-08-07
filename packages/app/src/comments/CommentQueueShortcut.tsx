/**
 * ⇧⌘Enter — send the comments the open Comments tab is showing as checked.
 *
 * Renders nothing; it exists to hold a window listener at a mount point that
 * outlives the Comments tab, so the chord works while the caret is in the
 * editor rather than only after a click has moved focus to the panel.
 *
 * **It sends nothing while the Comments tab is closed.** The panel publishes its
 * scope (`visible-scope.ts`) and the chord dispatches only what that scope would
 * send. Falling back to the whole checked queue gave the chord its WIDEST reach
 * exactly when the user could see least — an irreversible project-wide send with
 * nothing on screen saying what was in it. A send you cannot see is not a
 * shortcut, so with no panel the key is left alone entirely.
 *
 * NOT ⌘Enter, which TipTap's hardBreak and CodeMirror's insertBlankLine already
 * own — a window listener there would fire while someone types a line break.
 * ⇧⌘Enter is unclaimed: `prosemirror-keymap` resolves it to `Shift-Meta-Enter`
 * and its strip-Shift-and-retry fallback is gated on `name.length == 1`, so a
 * named key never degrades into its non-shift binding.
 */

import { useEffect } from 'react';
import { matchesKeyboardShortcut } from '@/lib/keyboard-shortcuts';
import { isOverlayLayerOpen } from '@/lib/overlay-layers';
import { getSelectedQueue, getSelectedQueueForDoc } from './store';
import { useSendQueue } from './use-send-queue';
import { getVisibleCommentScope } from './visible-scope';

export function CommentQueueShortcut() {
  const sendQueue = useSendQueue();

  // No subscription to the queue or the visible scope: BOTH are read at press
  // time below, so a render on every tick and every scope flip would buy
  // nothing. `useSendQueue` still needs its own — the destination decides
  // whether a send appends or starts a chat, and that is baked into the
  // closure.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!matchesKeyboardShortcut(event, 'send-comment-queue')) return;
      // Deliberately NOT gated on the target being editable: the editor body is
      // contenteditable, so such a guard would make the chord dead in the one
      // place a user actually stands, live only once a click moved focus out.
      // Typing cannot collide with it either way — no editor binds ⇧⌘Enter
      // (hardBreak takes Shift-Enter and Mod-Enter, and `ComposerMentionInput`
      // submits only on an unshifted Enter), so the event reaches this listener
      // unclaimed.
      //
      // A modal IS a different context, and every other global chord here bows
      // to one — dispatching a batch from behind a dialog would be acting on a
      // surface the user cannot see.
      if (isOverlayLayerOpen()) return;
      // Read at press time, not from the render that installed the listener: a
      // snapshot taken there would be one interaction stale, and the scope can
      // change under a listener that never re-installs.
      const visible = getVisibleCommentScope();
      // Nothing on screen to send FROM. Return before `preventDefault` so the
      // key stays the browser's rather than being swallowed for a no-op.
      if (visible === null) return;
      const ids =
        visible.scope === 'doc' ? getSelectedQueueForDoc(visible.docName) : getSelectedQueue();
      // Claim the chord only when there is something to send. Scoped, so
      // ⇧⌘Enter over a doc whose comments are all unticked stays unclaimed even
      // with a full project queue behind it.
      if (ids.length === 0) return;
      event.preventDefault();
      sendQueue(ids);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [sendQueue]);

  return null;
}
