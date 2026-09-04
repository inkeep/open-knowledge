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
    undoManager?.stopCapturing();
  }
}
