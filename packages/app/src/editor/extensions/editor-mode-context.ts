import type { Editor } from '@tiptap/core';

const editorSourceMode = new WeakMap<Editor, boolean>();

export function setEditorSourceMode(editor: Editor, isSourceMode: boolean): void {
  editorSourceMode.set(editor, isSourceMode);
}

export function getEditorSourceMode(editor: Editor): boolean {
  return editorSourceMode.get(editor) ?? false;
}
