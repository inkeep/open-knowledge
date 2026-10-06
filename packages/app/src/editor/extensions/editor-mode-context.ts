import type { Editor } from '@tiptap/core';

const editorSourceMode = new WeakMap<Editor, boolean>();
const editorSingleFileMode = new WeakMap<Editor, boolean>();

export function setEditorSourceMode(editor: Editor, isSourceMode: boolean): void {
  editorSourceMode.set(editor, isSourceMode);
}

export function getEditorSourceMode(editor: Editor): boolean {
  return editorSourceMode.get(editor) ?? false;
}

export function setEditorSingleFileMode(editor: Editor, singleFile: boolean): void {
  editorSingleFileMode.set(editor, singleFile);
}

export function getEditorSingleFileMode(editor: Editor): boolean {
  return editorSingleFileMode.get(editor) ?? false;
}
