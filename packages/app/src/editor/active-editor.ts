/**
 * Module-level registry mapping docName → Editor instance.
 *
 * Also exposed to Playwright via `window.__activeEditor` (DEV-gated in
 * `DocumentContext.tsx`) so tests can poll `editor.state.selection` directly
 * — the authoritative PM source of truth — instead of racing DOM-selection
 * reads against ProseMirror's DOMObserver sync.
 *
 * `click → keyboard.press(Tab|Enter|arrow)`
 * sequences where the key command reads PM internal state require a
 * PM-state-aware wait, not a DOM-frame yield.
 *
 * Registry is module-scope, not pooled — `EditorActivityPool` can mount up
 * to `ACTIVITY_MOUNT_LIMIT` (3) editors concurrently. Last-writer wins per
 * docName; `getEditorForDoc` resolves via `activeDocName` in DocumentContext
 * so the getter picks the currently-active entry, not whichever registered
 * last.
 */

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

/**
 * Remove the registry entry for `docName` — but only if the currently-registered
 * editor ref matches `editor`. Guards against StrictMode / HMR double-invoke
 * where the previous effect's cleanup runs after the next effect's mount has
 * already registered a new ref.
 */
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
