/**
 * Dispatch a transaction as its OWN y-undo stack item.
 *
 * The WYSIWYG linkify surfaces add their mark within `captureTimeout` of the
 * typing that triggered them (500 ms — Y.js's default, not OK config), so
 * without a capture split Y.UndoManager
 * merges the mark into the typing's stack item — one undo then deletes the
 * typed text too. `stopCapturing()` before the dispatch splits the item off
 * the preceding typing; `stopCapturing()` after closes it so the user's NEXT
 * keystrokes don't merge in either (undoing them would strip the mark as a
 * side effect). Both calls are synchronous — the correctness-critical sequence
 * lives here, in one place, so every mark-producing surface shares the exact
 * same contract. Absent a y-undo binding (non-collaborative editors) there is
 * no capture stack and the dispatch happens plain.
 */

import type { Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { yUndoPluginKey } from '@tiptap/y-tiptap';
import type { UndoManager } from 'yjs';

export function dispatchAsOwnUndoStep(view: EditorView, tr: Transaction): void {
  const undoState: { undoManager?: UndoManager } | undefined = yUndoPluginKey.getState(view.state);
  const undoManager = undoState?.undoManager;
  undoManager?.stopCapturing();
  try {
    view.dispatch(tr);
  } finally {
    // `dispatch` runs third-party plugin hooks and can throw. The closing
    // stopCapturing must run regardless — a split-open-but-never-closed
    // capture would merge the user's NEXT keystrokes into the failed item,
    // and a later undo would strip them together (silent undo corruption).
    undoManager?.stopCapturing();
  }
}
