/**
 * Nested list-item boundary merges for Backspace/Delete.
 *
 * StarterKit's ListKeymap sub-extension drives GFM-correct Backspace/Delete
 * in lists (see shared.ts's `listKeymap` wiring), but two of its branches
 * misfire at NESTED item boundaries — schema-independently, by upstream
 * design (@tiptap/extension-list, keymap handleBackspace/handleDelete):
 *
 * - Backspace at the start of item B whose PREVIOUS sibling item A has a
 *   nested sublist: the `previousListItemHasSubList` check skips
 *   joinItemBackward and falls through to `liftListItem` — the fallthrough
 *   meant for the FIRST item in a list — lifting B clean out into a bare
 *   paragraph with no bullet/checkbox (issue #609's orphan rows).
 * - Delete at the end of a NESTED item when the next item sits SHALLOWER:
 *   the `nextListIsHigher` branch runs `joinForward().joinBackward()`,
 *   re-nesting the next item at the wrong depth and silently dropping its
 *   `checked` attr (`- [ ] d` becomes `  - d`).
 *
 * This extension preempts EXACTLY those two configurations (all four key
 * bindings ListKeymap holds: Backspace/Delete and their Mod- variants) with
 * prosemirror-commands' joinTextblockBackward/joinTextblockForward, which
 * descend through container nodes to the adjacent textblocks and merge only
 * those — never re-parenting, never dropping the surviving item's attrs.
 * Every other configuration returns false so ListKeymap's good branches
 * (flat joins, first-item lift, undoInputRule, trailing-paragraph rejoin,
 * empty-nested-item removal) keep running unchanged.
 *
 * Registration order is load-bearing: this extension sits AFTER StarterKit
 * in sharedExtensions at the DEFAULT priority. At equal priority the
 * later-registered extension's key handler runs first, which is the whole
 * delivery mechanism — no priority escalation, so suggestion-layer plugins
 * (slash command, tag/wiki-link at the 200 band, precedent #48) keep their
 * Enter/Tab precedence untouched.
 */

import { Extension } from '@tiptap/core';
import { joinTextblockBackward, joinTextblockForward } from '@tiptap/pm/commands';
import type { Node as PmNode, ResolvedPos } from '@tiptap/pm/model';
import { type EditorState, TextSelection } from '@tiptap/pm/state';

/** Depth of the nearest `listItem` ancestor, or null when outside a list. */
function listItemDepth($pos: ResolvedPos): number | null {
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === 'listItem') return d;
  }
  return null;
}

// Recursive on purpose: mirrors upstream ListKeymap's descendants-based
// `listItemHasSubList`, so this guard fires exactly when upstream's lift
// branch would misfire. A shallow direct-child scan diverges for legal
// shapes like listItem > blockquote > list (listItem content is
// `paragraph block*`), where upstream still lifts but a shallow guard
// would not preempt.
function itemContainsSublist(item: PmNode): boolean {
  let found = false;
  item.descendants((child) => {
    if (found) return false;
    if (child.type.name === 'list') found = true;
    return !found;
  });
  return found;
}

/** Resolved cursor, or null for ranged/Node selections (never handled). */
function cursorOf(state: EditorState): ResolvedPos | null {
  const { selection } = state;
  return selection instanceof TextSelection ? selection.$cursor : null;
}

/**
 * Mirror of the exact configuration where ListKeymap's handleBackspace
 * falls through to `liftListItem` despite a previous sibling existing:
 * cursor at the very start of an item's first textblock, previous sibling
 * item present, and that sibling contains a nested list.
 */
function isNestedBoundaryBackspace(state: EditorState): boolean {
  const $cursor = cursorOf(state);
  if (!$cursor || $cursor.parentOffset !== 0) return false;
  const li = listItemDepth($cursor);
  if (li === null) return false;
  if ($cursor.depth !== li + 1 || $cursor.index(li) !== 0) return false;
  const itemIndex = $cursor.index(li - 1);
  if (itemIndex === 0) return false; // first item: stock lift-out is correct
  const prevItem = $cursor.node(li - 1).child(itemIndex - 1);
  return itemContainsSublist(prevItem);
}

/**
 * Depth of the list item that starts immediately after the item at depth
 * `li`, descending through wrapper lists; null when what follows is not a
 * list item (end of document, trailing paragraph, ...).
 */
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

/**
 * Mirror of the exact configuration where ListKeymap's handleDelete takes
 * its `nextListIsHigher` branch: cursor at the very end of a listItem (its
 * last textblock, last-child chain all the way up) and the next item in
 * document order sits shallower than the cursor's item.
 */
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
      // ListKeymap consults undoInputRule before anything else; preserve
      // that precedence in the one configuration this extension owns (a
      // fresh `- ` autoformat can land in this configuration when the new
      // item joins a list whose last item has a sublist).
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
