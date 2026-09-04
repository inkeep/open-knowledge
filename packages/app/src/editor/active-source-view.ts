import type { EditorView } from '@codemirror/view';

const sourceViews = new Map<string, EditorView>();
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

export function registerSourceView(docName: string, view: EditorView): void {
  sourceViews.set(docName, view);
  notifyListeners();
}

export function unregisterSourceView(docName: string, view: EditorView): void {
  if (sourceViews.get(docName) === view) {
    sourceViews.delete(docName);
    notifyListeners();
  }
}

export function getSourceViewForDoc(docName: string): EditorView | null {
  return sourceViews.get(docName) ?? null;
}

export function subscribeSourceViewRegistry(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
