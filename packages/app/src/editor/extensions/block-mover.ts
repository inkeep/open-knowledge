import { Extension } from '@tiptap/core';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { TextSelection } from '@tiptap/pm/state';

export function currentTopLevelBlock(state: EditorState): { from: number; to: number } | null {
  const { $from } = state.selection;
  if ($from.depth === 0) return null;
  const from = $from.before(1);
  const to = $from.after(1);
  return { from, to };
}

export function moveBlockUp(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
): boolean {
  const block = currentTopLevelBlock(state);
  if (!block) return false;

  const { from, to } = block;
  if (from === 0) return false;

  const $above = state.doc.resolve(from - 1);
  if ($above.depth === 0) return false;

  const aboveFrom = $above.before(1);
  const movingNode = state.doc.slice(from, to).content;
  const aboveNode = state.doc.slice(aboveFrom, from).content;

  if (!dispatch) return true;

  const tr = state.tr;
  tr.replaceWith(aboveFrom, to, movingNode.append(aboveNode));

  const newBlockStart = aboveFrom + 1;
  const newBlockEnd = aboveFrom + movingNode.size;
  const cursorOffset = state.selection.from - from;
  const newCursorPos = Math.min(newBlockStart + cursorOffset, newBlockEnd);
  tr.setSelection(TextSelection.near(tr.doc.resolve(newCursorPos)));
  tr.scrollIntoView();
  dispatch(tr);
  return true;
}

export function moveBlockDown(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
): boolean {
  const block = currentTopLevelBlock(state);
  if (!block) return false;

  const { from, to } = block;
  if (to >= state.doc.content.size) return false;

  const $below = state.doc.resolve(to + 1);
  if ($below.depth === 0) return false;

  const belowTo = $below.after(1);
  const movingNode = state.doc.slice(from, to).content;
  const belowNode = state.doc.slice(to, belowTo).content;

  if (!dispatch) return true;

  const tr = state.tr;
  tr.replaceWith(from, belowTo, belowNode.append(movingNode));

  const newBlockStart = from + belowNode.size + 1;
  const newBlockEnd = from + belowNode.size + movingNode.size;
  const cursorOffset = state.selection.from - from;
  const newCursorPos = Math.min(newBlockStart + cursorOffset, newBlockEnd);
  tr.setSelection(TextSelection.near(tr.doc.resolve(newCursorPos)));
  tr.scrollIntoView();
  dispatch(tr);
  return true;
}

export const BlockMover = Extension.create({
  name: 'blockMover',

  addKeyboardShortcuts() {
    return {
      'Mod-Shift-ArrowUp': ({ editor }) => moveBlockUp(editor.state, editor.view.dispatch),
      'Mod-Shift-ArrowDown': ({ editor }) => moveBlockDown(editor.state, editor.view.dispatch),
    };
  },
});
