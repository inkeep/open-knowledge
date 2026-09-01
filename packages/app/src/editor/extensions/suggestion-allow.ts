import type { Editor, Range } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import { isInLiteralTextContext } from '../literal-text-context';
import { getEditorSourceMode } from './editor-mode-context';

export function suggestionAllow({
  editor,
  state,
  range,
}: {
  editor: Editor;
  state: EditorState;
  range: Range;
}): boolean {
  if (getEditorSourceMode(editor)) return false;
  return !isInLiteralTextContext(state, range.from, range.to);
}
