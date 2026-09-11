import type { Extension } from '@codemirror/state';
import { type EditorView, ViewPlugin } from '@codemirror/view';
import type * as Y from 'yjs';

export interface SourceUndoFlipDeps {
  undoManager: Y.UndoManager;
}

export interface SourceUndoFlipTracker {
  setSourceModeActive(active: boolean): void;
  destroy(): void;
}

export function createSourceUndoFlipTracker({
  undoManager,
}: SourceUndoFlipDeps): SourceUndoFlipTracker {
  let active = false;
  let destroyed = false;

  return {
    setSourceModeActive(next: boolean) {
      if (destroyed || next === active) return;
      active = next;
      if (!next) undoManager.stopCapturing();
    },
    destroy() {
      destroyed = true;
    },
  };
}

const trackerByView = new WeakMap<EditorView, SourceUndoFlipTracker>();

export function createSourceUndoFlipExtension(deps: SourceUndoFlipDeps): Extension {
  return ViewPlugin.define((view) => {
    const tracker = createSourceUndoFlipTracker(deps);
    trackerByView.set(view, tracker);
    return {
      destroy() {
        tracker.destroy();
      },
    };
  });
}

export function setSourceViewUndoFlipActive(view: EditorView, active: boolean): void {
  const tracker = trackerByView.get(view);
  if (!tracker) {
    throw new Error('createSourceUndoFlipExtension is not installed on this EditorView');
  }
  tracker.setSourceModeActive(active);
}
