import type { Extension } from '@codemirror/state';
import { type EditorView, ViewPlugin } from '@codemirror/view';
import type * as Y from 'yjs';
import { mark } from '@/lib/perf';

export interface SourceUndoFlipDeps {
  docName: string;
  ytext: Y.Text;
  undoManager: Y.UndoManager;
}

export interface SourceUndoFlipTracker {
  setSourceModeActive(active: boolean): void;
  destroy(): void;
}

function isTrackedOrigin(undoManager: Y.UndoManager, origin: unknown): boolean {
  const tracked = undoManager.trackedOrigins as Set<unknown>;
  if (tracked.has(origin)) return true;
  if (!origin) return false;
  return tracked.has(origin.constructor);
}

export function createSourceUndoFlipTracker(deps: SourceUndoFlipDeps): SourceUndoFlipTracker {
  const { docName, ytext, undoManager } = deps;
  let active = false;
  let sawUntrackedRewrite = false;
  let destroyed = false;

  const handler = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
    if (active) return;
    if (isTrackedOrigin(undoManager, transaction.origin)) return;
    sawUntrackedRewrite = true;
  };
  ytext.observe(handler);

  return {
    setSourceModeActive(next: boolean) {
      if (destroyed) return;
      if (next === active) return;
      if (!next) {
        active = false;
        undoManager.stopCapturing();
        return;
      }
      if (sawUntrackedRewrite) {
        undoManager.clear();
        mark('ok/source-undo/flip-clear', { docName });
      }
      sawUntrackedRewrite = false;
      active = true;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      ytext.unobserve(handler);
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
