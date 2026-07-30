/**
 * Module-level registry mapping docName → the doc's live CodeMirror source view.
 * The TipTap twin of this registry is `active-editor.ts`.
 *
 * Two consumers, both needing a view that `SourceEditor` otherwise keeps in a
 * component-local ref:
 *
 *   - The mode-toggle chokepoint captures the outgoing editor's viewport at flip
 *     time, before React hides it. For a source-to-WYSIWYG flip the outgoing
 *     editor is CodeMirror, so it reads the live view here for that synchronous,
 *     one-shot capture.
 *   - Outline active-heading tracking measures heading line geometry off the
 *     view's height map. That consumer is reactive, which is why this registry
 *     carries a subscriber channel: a view mounting is not a React state change,
 *     so a consumer that read the map once per mount would stay frozen when the
 *     view arrives later.
 *
 * An entry means "mounted", not merely "constructed" — tracking measures
 * on-screen line positions, so an entry left behind for a parked view would
 * answer with positions that are no longer on screen.
 */

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

/**
 * Remove the entry for `docName`, but only while the registered view still is
 * `view`. StrictMode and HMR run the previous mount's cleanup after the next
 * mount has already registered, so deleting by docName alone would leave the
 * live view unreachable and tracking permanently dead.
 */
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
