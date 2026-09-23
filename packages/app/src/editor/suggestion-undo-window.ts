import type { Editor } from '@tiptap/core';
import { projectionUndoManager } from './projection-binding';

/* STOP: the trigger text ("/he") is real content in Y.Text, so it is its own undo step the
   moment the user pauses past captureTimeout. Holding the capture window open for the life
   of the menu makes the trigger and the command that consumes it one step, so undo never
   resurrects a slash command whose result it just removed.
   open() must NOT stopCapturing: Suggestion's onStart fires a tick AFTER the trigger
   character is already in the document, so cutting there strands the "/" in the previous
   item. Only close() cuts, so the next keystroke starts fresh. */
export interface SuggestionUndoWindow {
  open(): void;
  close(): void;
}

export function createSuggestionUndoWindow(getEditor: () => Editor | null): SuggestionUndoWindow {
  let previousTimeout: number | null = null;

  const manager = () => {
    const editor = getEditor();
    if (editor === null || editor.isDestroyed) return null;
    return projectionUndoManager(editor.state);
  };

  return {
    open() {
      if (previousTimeout !== null) return;
      const um = manager();
      if (um === null) return;
      previousTimeout = um.captureTimeout;
      um.captureTimeout = Number.POSITIVE_INFINITY;
    },
    close() {
      if (previousTimeout === null) return;
      const restore = previousTimeout;
      previousTimeout = null;
      const um = manager();
      if (um === null) return;
      um.captureTimeout = restore;
      um.stopCapturing();
    },
  };
}
