import type { Editor, Range } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import { isInLiteralTextContext } from '../literal-text-context';
import { getEditorSourceMode } from './editor-mode-context';
import { allowOutsideComposition } from './suggestion-ime';

export function suggestionAllow({
  editor,
  state,
  range,
  isActive,
}: {
  editor: Editor;
  state: EditorState;
  range: Range;
  isActive?: boolean;
}): boolean {
  if (getEditorSourceMode(editor)) return false;
  if (!allowOutsideComposition({ editor, isActive })) return false;
  return !isInLiteralTextContext(state, range.from, range.to);
}
