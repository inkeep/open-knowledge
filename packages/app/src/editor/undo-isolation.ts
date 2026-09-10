import type { Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { projectionUndoManager } from './projection-binding';

export function dispatchAsOwnUndoStep(view: EditorView, tr: Transaction): void {
  const undoManager = projectionUndoManager(view.state);
  undoManager?.stopCapturing();
  try {
    view.dispatch(tr);
  } finally {
    undoManager?.stopCapturing();
  }
}

/* STOP: a conversion whose literal bytes already parse as the converted form (a link typed as
   `[text](url)` or a bare URL) must NOT be split off from the keystrokes that typed it. Undoing
   it alone re-derives the same mark from the bytes: the view does not change, or disagrees with
   the file. Close the step after it instead. */
export function dispatchClosingUndoStep(view: EditorView, tr: Transaction): void {
  const undoManager = projectionUndoManager(view.state);
  try {
    view.dispatch(tr);
  } finally {
    undoManager?.stopCapturing();
  }
}
