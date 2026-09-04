import type { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';

const undoManagersByText = new WeakMap<Y.Text, Y.UndoManager>();

export function acquireDocUndoManager(provider: HocuspocusProvider, ytext: Y.Text): Y.UndoManager {
  const existing = undoManagersByText.get(ytext);
  if (existing) return existing;

  const undoManager = new Y.UndoManager(ytext);
  undoManagersByText.set(ytext, undoManager);
  const doc = ytext.doc;

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    provider.off('destroy', release);
    doc?.off('destroy', release);
    if (undoManagersByText.get(ytext) === undoManager) undoManagersByText.delete(ytext);
    undoManager.clear();
    undoManager.destroy();
  };

  provider.on('destroy', release);
  doc?.on('destroy', release);

  return undoManager;
}

export function __peekDocUndoManager(ytext: Y.Text): Y.UndoManager | undefined {
  return undoManagersByText.get(ytext);
}
