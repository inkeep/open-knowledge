import { Extension } from '@tiptap/core';
import { Fragment } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { NodeSelection, PluginKey, TextSelection } from '@tiptap/pm/state';
import { dispatchAsOwnUndoStep } from '../undo-isolation.ts';
import { listItemIntersectsSelection, normalizeList } from './list-editing-helpers.ts';

export const blockMoveAnnouncementKey = new PluginKey<'up' | 'down'>('blockMoveAnnouncement');

function moveListItems(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  direction: -1 | 1,
): boolean | null {
  const { selection, doc } = state;
  const { $from } = selection;
  let depth = $from.depth;
  while (depth > 0 && $from.node(depth).type.name !== 'list') depth--;
  if (depth === 0 || selection.to > $from.end(depth)) return null;
  const list = $from.node(depth);
  const listPos = $from.before(depth);
  let from = -1;
  let to = -1;
  list.forEach((item, offset) => {
    const pos = listPos + 1 + offset;
    const intersects = selection.empty
      ? pos <= selection.from && selection.from < pos + item.nodeSize
      : listItemIntersectsSelection(selection, pos, item.nodeSize);
    if (intersects) {
      if (from < 0) from = pos;
      to = pos + item.nodeSize;
    }
  });
  if (from < 0) return null;
  const adjacent = direction === -1 ? doc.resolve(from).nodeBefore : doc.resolve(to).nodeAfter;
  let target: number;
  let wrap = false;
  if (adjacent) {
    target = direction === -1 ? from - adjacent.nodeSize : to + adjacent.nodeSize;
  } else if (depth > 1 && $from.node(depth - 1).type.name === 'listItem') {
    target = direction === -1 ? $from.before(depth - 1) : $from.after(depth - 1);
  } else if (depth === 1) {
    const $edge = doc.resolve(direction === -1 ? listPos : listPos + list.nodeSize);
    const block = direction === -1 ? $edge.nodeBefore : $edge.nodeAfter;
    if (!block) return false;
    target = direction === -1 ? listPos - block.nodeSize : listPos + list.nodeSize + block.nodeSize;
    wrap = true;
  } else {
    return null;
  }
  if (!dispatch) return true;
  const moved = doc.slice(from, to).content;
  const content = wrap ? Fragment.from(list.copy(moved)) : moved;
  const tr = state.tr.deleteRange(from, to);
  const insertAt = tr.mapping.map(target);
  tr.insert(insertAt, content);
  const movedWholeList = to - from === list.content.size;
  if (!movedWholeList) normalizeList(tr, tr.mapping.map(listPos));
  if (!(wrap && movedWholeList)) {
    const $insert = tr.doc.resolve(insertAt);
    normalizeList(tr, wrap ? insertAt : $insert.before());
  }
  const offset = insertAt + (wrap ? 1 : 0) - from;
  tr.setSelection(
    selection instanceof NodeSelection
      ? NodeSelection.create(tr.doc, selection.from + offset)
      : TextSelection.create(tr.doc, selection.anchor + offset, selection.head + offset),
  );
  dispatch(tr.scrollIntoView());
  return true;
}

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
  const movedItems = moveListItems(state, dispatch, -1);
  if (movedItems !== null) return movedItems;
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
  const movedItems = moveListItems(state, dispatch, 1);
  if (movedItems !== null) return movedItems;
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
      'Mod-Shift-ArrowUp': ({ editor }) =>
        moveBlockUp(editor.state, (tr) =>
          dispatchAsOwnUndoStep(editor.view, tr.setMeta(blockMoveAnnouncementKey, 'up')),
        ),
      'Mod-Shift-ArrowDown': ({ editor }) =>
        moveBlockDown(editor.state, (tr) =>
          dispatchAsOwnUndoStep(editor.view, tr.setMeta(blockMoveAnnouncementKey, 'down')),
        ),
    };
  },
});
