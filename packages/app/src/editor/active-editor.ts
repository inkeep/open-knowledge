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
 * Registry is module-scope, not pooled — `EditorActivityPool` mounts every
 * visible pane plus an `ACTIVITY_MOUNT_LIMIT` (3) warm-background floor.
 * Last-writer wins per docName; split view keeps one editor per docName, and
 * `getEditorForDoc` resolves via `activeDocName` in DocumentContext so the
 * getter picks the focused entry rather than whichever registered last.
 */

import type { Editor } from '@tiptap/core';
import { getEditorView } from '@/editor/utils/get-editor-view';

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

/**
 * The editor for `docName`, but only while it is actually ON SCREEN.
 *
 * Registration means mounted, not visible. `EditorActivityPool` keeps the last
 * few visited documents mounted behind `<Activity mode="hidden">`, which holds
 * their DOM (and this registry entry) while hiding them with `display:none`.
 * Anything that decides "do I need to navigate?" by asking whether an editor
 * exists therefore acts on an invisible one for exactly those recent documents:
 * it scrolls a pane nobody can see and never navigates, so the gesture silently
 * does nothing for the docs you were just in and works everywhere else.
 *
 * Layout, not a route comparison: a hidden subtree has no client rects, which is
 * also the precondition for measuring anything in it. That keeps this right in
 * split view, where two documents are on screen and only one is in the hash.
 */
export function getVisibleEditorForDoc(docName: string): Editor | null {
  const editor = editors.get(docName);
  if (!editor || editor.isDestroyed) return null;
  // `editorView`, never `editor.view` — the latter is a throwing proxy before
  // ProseMirror mounts, which is precisely the window this is asked about.
  const dom = getEditorView(editor)?.dom;
  if (!dom?.isConnected) return null;
  return dom.getClientRects().length > 0 ? editor : null;
}

export function subscribeEditorRegistry(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
