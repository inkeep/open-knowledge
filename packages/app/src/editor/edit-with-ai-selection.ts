/**
 * Selection -> markdown extraction for the WYSIWYG "Edit with AI" handoff.
 * The selected ProseMirror slice runs through the same `sliceToDocJson` ->
 * `MarkdownManager.serialize` path the clipboard text serializer uses, so an
 * "Edit with AI" passage is byte-identical to what copy/paste emits for the
 * same selection. Feeds `composeSelectionPrompt` via `buildSelectionHandoffInput`.
 */

import type { Editor } from '@tiptap/react';
import { sliceToDocJson } from './clipboard/serialize.ts';
import { getSharedMarkdownManager } from './utils/md-singleton.ts';

/**
 * Serialize the WYSIWYG editor's current text selection to markdown.
 *
 * Leading and trailing whitespace — including the newline the markdown
 * serializer appends for block structure — is trimmed; it is pipeline
 * structure, not part of the passage the user picked. An empty selection
 * yields the empty string; the affordance is render-gated on a non-empty
 * selection, so callers treat that as nothing-to-dispatch.
 */
export function serializeWysiwygSelection(editor: Editor): string {
  const slice = editor.state.selection.content();
  const json = sliceToDocJson(slice, editor.state.schema);
  return getSharedMarkdownManager().serialize(json).trim();
}
