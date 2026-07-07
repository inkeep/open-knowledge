/**
 * Per-editor source-mode signal — keyed on the TipTap Editor instance via
 * WeakMap so a dropped/closed editor automatically evicts its entry.
 *
 * Read by every `@tiptap/suggestion`-based extension's `allow` predicate so
 * bridge-propagated transactions (CodeMirror → Y.Text → Y.XmlFragment) cannot
 * activate floating popups that portal to `document.body` and escape the
 * `.ok-mode-hidden` wrapper. Producer is the React `isSourceMode` prop in
 * `TiptapEditor.tsx`, plumbed through a dedicated useEffect via
 * `setEditorSourceMode`.
 *
 * Follows the same pattern as `doc-context.ts`'s per-editor registry: a
 * module-level WeakMap sits outside the React-hook contract, so React
 * Compiler does not flag the write as a mutation on a hook-derived value.
 * `editor.storage`-based storage was tried first and rejected because the
 * Compiler treats `editor.storage.x = y` as a forbidden mutation on the
 * hook-returned `editor` (matching the rationale documented in
 * `doc-context.ts`).
 */
import type { Editor } from '@tiptap/core';

const editorSourceMode = new WeakMap<Editor, boolean>();

export function setEditorSourceMode(editor: Editor, isSourceMode: boolean): void {
  editorSourceMode.set(editor, isSourceMode);
}

export function getEditorSourceMode(editor: Editor): boolean {
  // Default `false` = WYSIWYG (suggestions allowed) is load-bearing — keeps
  // the mount-race window between editor construction and the first
  // `setEditorSourceMode` write from suppressing the slash menu for a beat.
  return editorSourceMode.get(editor) ?? false;
}
