/**
 * At equal priority the later-registered extension's key handler runs first, which is the whole
 * delivery mechanism — no priority escalation, so suggestion-layer plugins (slash command,
 * tag/wiki-link at the 200 band, precedent #48) keep their Enter/Tab precedence untouched.
 */

import { Extension } from '@tiptap/core';
import { joinTextblockBackward, joinTextblockForward } from '@tiptap/pm/commands';
import type { Node as PmNode, ResolvedPos } from '@tiptap/pm/model';
import { type EditorState, TextSelection } from '@tiptap/pm/state';

function listItemDepth($pos: ResolvedPos): number | null {
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === 'listItem') return d;
  }
  return null;
}

function itemContainsSublist(item: PmNode): boolean {
  let found = false;
  item.descendants((child) => {
    if (found) return false;
    if (child.type.name === 'list') found = true;
    return !found;
  });
  return found;
}

function cursorOf(state: EditorState): ResolvedPos | null {
  const { selection } = state;
  return selection instanceof TextSelection ? selection.$cursor : null;
}

function isNestedBoundaryBackspace(state: EditorState): boolean {
  const $cursor = cursorOf(state);
  if ($cursor?.parentOffset !== 0) return false;
  const li = listItemDepth($cursor);
  if (li === null) return false;
  if ($cursor.depth !== li + 1 || $cursor.index(li) !== 0) return false;
  const itemIndex = $cursor.index(li - 1);
  if (itemIndex === 0) return false;
  const prevItem = $cursor.node(li - 1).child(itemIndex - 1);
  return itemContainsSublist(prevItem);
}

function nextListItemDepthAfter($cursor: ResolvedPos, li: number): number | null {
  for (let d = li - 1; d >= 0; d--) {
    const parent = $cursor.node(d);
    const idx = $cursor.index(d);
    if (idx < parent.childCount - 1) {
      let node = parent.child(idx + 1);
      let depth = d + 1;
      while (node.type.name === 'list' && node.firstChild) {
        node = node.firstChild;
        depth += 1;
      }
      return node.type.name === 'listItem' ? depth : null;
    }
  }
  return null;
}

function isNestedBoundaryDelete(state: EditorState): boolean {
  const $cursor = cursorOf(state);
  if (!$cursor || $cursor.parentOffset !== $cursor.parent.content.size) return false;
  const li = listItemDepth($cursor);
  if (li === null) return false;
  for (let d = $cursor.depth; d > li; d--) {
    if ($cursor.index(d - 1) !== $cursor.node(d - 1).childCount - 1) return false;
  }
  const nextDepth = nextListItemDepthAfter($cursor, li);
  return nextDepth !== null && nextDepth < li;
}

export const ListBoundaryMerge = Extension.create({
  name: 'listBoundaryMerge',

  addKeyboardShortcuts() {
    const backspace = () => {
      const { editor } = this;
      if (!isNestedBoundaryBackspace(editor.state)) return false;
      if (editor.commands.undoInputRule()) return true;
      const { state, view } = editor;
      return joinTextblockBackward(state, view.dispatch, view);
    };
    const forwardDelete = () => {
      const { editor } = this;
      if (!isNestedBoundaryDelete(editor.state)) return false;
      const { state, view } = editor;
      return joinTextblockForward(state, view.dispatch, view);
    };
    return {
      Backspace: backspace,
      'Mod-Backspace': backspace,
      Delete: forwardDelete,
      'Mod-Delete': forwardDelete,
    };
  },
});
