import type { Editor } from '@tiptap/core';

const editorDocName = new WeakMap<Editor, string>();

export function setEditorDocName(editor: Editor, docName: string | null): void {
  if (docName === null) {
    editorDocName.delete(editor);
    return;
  }
  editorDocName.set(editor, docName);
}

export function getEditorDocName(editor: Editor): string | null {
  return editorDocName.get(editor) ?? null;
}
