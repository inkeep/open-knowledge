
import type { Editor } from '@tiptap/core';

const editors = new Map<string, Editor>();
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

export function registerEditor(docName: string, editor: Editor): void {
  editors.set(docName, editor);
  notifyListeners();
}

export function unregisterEditor(docName: string, editor: Editor): void {
  if (editors.get(docName) === editor) {
    editors.delete(docName);
    notifyListeners();
  }
}

export function getEditorForDoc(docName: string): Editor | null {
  return editors.get(docName) ?? null;
}

export function subscribeEditorRegistry(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
