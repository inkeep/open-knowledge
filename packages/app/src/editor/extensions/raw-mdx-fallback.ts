/**
 * App-specific RawMdxFallback extension — extends core with React NodeView.
 *
 * The core RawMdxFallback handles schema + markdown. This version adds
 * the React NodeView renderer for the browser editor.
 *
 * NodeView embeds a CodeMirror 6 editor for inline editing
 * of raw MDX source, replacing the plain-text badge view.
 * Direct PM dispatch pattern (Precedent #28), NOT y-codemirror.next.
 *
 * Outer arrow-into handler (canonical PM+CM pattern per
 * <https://prosemirror.net/examples/codemirror/>): when the outer PM cursor
 * is at a textblock boundary and the user presses an arrow key whose
 * natural target is this fallback block, nudge PM to land selection inside
 * the node. The RawMdxFallbackView's selectionUpdate effect (Precedent #31)
 * then forwards focus + caret into the nested CM.
 */
import { RawMdxFallback as BaseRawMdxFallback } from '@inkeep/open-knowledge-core';
import type { Editor } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import { Selection } from '@tiptap/pm/state';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { RawMdxFallbackView } from './RawMdxFallbackCMView';

/**
 * Given an editor state + arrow direction, return the PM Selection that
 * should be dispatched IF the next textblock-boundary hop lands inside a
 * rawMdxFallback node. Returns null when the hop is a no-op or lands
 * somewhere else.
 *
 * Caller is responsible for checking `view.endOfTextblock(dir)` first —
 * that check depends on DOM layout (line wrapping) for up/down and must
 * stay view-coupled. This helper does the selection-resolution + node-type
 * gate, which is pure state math and unit-testable.
 */
export function computeArrowIntoTargetAtBoundary(
  state: EditorState,
  dir: 'up' | 'down' | 'left' | 'right',
): Selection | null {
  if (!state.selection.empty) return null;
  const side: -1 | 1 = dir === 'up' || dir === 'left' ? -1 : 1;
  const $head = state.selection.$head;
  const boundary = side > 0 ? $head.after() : $head.before();
  if (typeof boundary !== 'number') return null;
  const nextSel = Selection.near(state.doc.resolve(boundary), side);
  if (nextSel.$head?.parent.type.name === 'rawMdxFallback') {
    return nextSel;
  }
  return null;
}

function arrowIntoRawMdxFallback(editor: Editor, dir: 'up' | 'down' | 'left' | 'right'): boolean {
  const { state, view } = editor;
  if (!view.endOfTextblock(dir)) return false;
  const nextSel = computeArrowIntoTargetAtBoundary(state, dir);
  if (!nextSel) return false;
  view.dispatch(state.tr.setSelection(nextSel));
  return true;
}

export const RawMdxFallback = BaseRawMdxFallback.extend({
  addKeyboardShortcuts() {
    return {
      ArrowLeft: ({ editor }) => arrowIntoRawMdxFallback(editor, 'left'),
      ArrowRight: ({ editor }) => arrowIntoRawMdxFallback(editor, 'right'),
      ArrowUp: ({ editor }) => arrowIntoRawMdxFallback(editor, 'up'),
      ArrowDown: ({ editor }) => arrowIntoRawMdxFallback(editor, 'down'),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(RawMdxFallbackView, {
      // stopEvent + ignoreMutation prevent PM's DOM observer from
      // interpreting CM's internal DOM mutations as PM changes.
      stopEvent: () => true,
      ignoreMutation: () => true,
    });
  },
});
