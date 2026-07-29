/**
 * Module-level registry mapping docName → the doc's live CodeMirror source view.
 *
 * The mode-toggle chokepoint captures the outgoing editor's viewport at flip
 * time, before React hides it. For a source-to-WYSIWYG flip the outgoing editor
 * is CodeMirror, whose view SourceEditor holds in a component-local ref — so it
 * publishes the live view here for that synchronous, one-shot capture to read.
 * The TipTap twin of this registry is `active-editor.ts`.
 *
 * Registration is last-writer-wins per docName; unregister matches on the view
 * ref so a StrictMode double-invoke (register-A, register-B, cleanup-A) does not
 * leave the map empty. No subscriber channel — unlike the TipTap registry no
 * reactive UI reads this, only the capture path.
 */

import type { EditorView } from '@codemirror/view';

const sourceViews = new Map<string, EditorView>();

export function registerSourceView(docName: string, view: EditorView): void {
  sourceViews.set(docName, view);
}

export function unregisterSourceView(docName: string, view: EditorView): void {
  if (sourceViews.get(docName) === view) {
    sourceViews.delete(docName);
  }
}

export function getSourceViewForDoc(docName: string): EditorView | null {
  return sourceViews.get(docName) ?? null;
}
