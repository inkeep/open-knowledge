import { isAllowedLinkUri } from '@inkeep/open-knowledge-core';
import { Extension, InputRule } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import { dispatchAsOwnUndoStep } from './undo-isolation';

const INLINE_LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)$/;

const LINK_MARK = 'link';

function collapseToLink(
  view: EditorView,
  from: number,
  fullMatch: string,
  text: string,
  href: string,
): void {
  if (view.isDestroyed || view.composing) return;
  const { state } = view;
  const markType = state.schema.marks[LINK_MARK];
  if (!markType) return;

  const to = from + fullMatch.length;
  if (from < 0 || to > state.doc.content.size) return;
  if (state.doc.textBetween(from, to) !== fullMatch) return;
  if (state.doc.rangeHasMark(from, to, markType)) return;

  const linked = state.schema.text(text, [markType.create({ href })]);
  try {
    dispatchAsOwnUndoStep(view, state.tr.replaceRangeWith(from, to, linked));
  } catch (err) {
    console.warn('[inline-link-rule] collapse dispatch failed', { from, text, href }, err);
  }
}

export const InlineLinkInputRule = Extension.create({
  name: 'inlineLinkInputRule',

  addInputRules() {
    const editor = this.editor;
    return [
      new InputRule({
        find: INLINE_LINK_RE,
        handler: ({ state, range, match }) => {
          const text = match[1];
          const url = match[2];
          if (!text || !url) return null;
          if (!isAllowedLinkUri(url)) return null;

          const markType = state.schema.marks[LINK_MARK];
          if (!markType) return null;
          if (state.doc.rangeHasMark(range.from, range.to, markType)) return null;

          const from = range.from;
          const fullMatch = match[0];
          const view = editor.view;
          queueMicrotask(() => collapseToLink(view, from, fullMatch, text, url));
          return null;
        },
      }),
    ];
  },
});
