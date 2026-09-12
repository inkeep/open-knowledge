import type { Editor } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';

/** Reference: precedent #18(b) on hybrid Activity + Suspense render trees. */
export function getEditorView(editor: Editor): EditorView | undefined {
  return (editor as unknown as { editorView?: EditorView }).editorView;
}
