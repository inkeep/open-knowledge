import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { requestDocPanelTab } from '@/components/doc-panel-events';
import {
  type CommentAnchor,
  getDocumentCommentSnapshot,
  setActiveDocumentComment,
  subscribeDocumentComments,
} from './comment-store';

const SEP = '\n';
const SEARCH_WINDOW = 500;

const documentCommentDecorationKey = new PluginKey<DecorationSet>('documentCommentDecoration');

function textOffsetToPmPos(doc: ProseMirrorNode, offset: number): number {
  const maxSize = doc.content.size;
  if (offset <= 0) return 0;
  const total = doc.textBetween(0, maxSize, SEP).length;
  if (offset >= total) return maxSize;

  let lo = 0;
  let hi = maxSize;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (doc.textBetween(0, mid, SEP).length < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function findPmRangeForCommentAnchor(
  doc: ProseMirrorNode,
  anchor: Pick<CommentAnchor, 'anchorText' | 'textStart' | 'textEnd'>,
): { from: number; to: number } | null {
  const anchorText = anchor.anchorText;
  if (!anchorText.trim()) return null;

  const textContent = doc.textBetween(0, doc.content.size, SEP);
  if (!textContent) return null;

  const searchFrom = Math.max(0, anchor.textStart - SEARCH_WINDOW);
  const searchTo = Math.min(
    textContent.length,
    anchor.textStart + anchorText.length + SEARCH_WINDOW,
  );
  const nearby = textContent.indexOf(anchorText, searchFrom);
  const textFrom = nearby !== -1 && nearby <= searchTo ? nearby : textContent.indexOf(anchorText);

  const fallbackFrom = Math.max(0, Math.min(anchor.textStart, textContent.length));
  const fallbackTo = Math.max(fallbackFrom, Math.min(anchor.textEnd, textContent.length));
  const fromOffset = textFrom === -1 ? fallbackFrom : textFrom;
  const toOffset = textFrom === -1 ? fallbackTo : textFrom + anchorText.length;
  const from = textOffsetToPmPos(doc, fromOffset);
  const to = textOffsetToPmPos(doc, toOffset);
  if (from >= to) return null;
  return { from, to };
}

function buildDecorations(docName: string, doc: ProseMirrorNode): DecorationSet {
  const snapshot = getDocumentCommentSnapshot(docName);
  const decorations: Decoration[] = [];

  for (const comment of snapshot.comments) {
    const range = findPmRangeForCommentAnchor(doc, comment);
    if (!range) continue;
    const active = snapshot.activeCommentId === comment.id;
    decorations.push(
      Decoration.inline(range.from, range.to, {
        class: active ? 'ok-comment ok-comment-active' : 'ok-comment',
        'data-ok-comment-id': comment.id,
      }),
    );
  }

  if (snapshot.pending) {
    const range = findPmRangeForCommentAnchor(doc, snapshot.pending);
    if (range) {
      decorations.push(
        Decoration.inline(range.from, range.to, {
          class: 'ok-comment-pending',
          'data-ok-comment-pending': 'true',
        }),
      );
    }
  }

  return DecorationSet.create(doc, decorations);
}

export function createDocumentCommentDecorationExtension(docName: string) {
  return Extension.create({
    name: 'documentCommentDecoration',

    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: documentCommentDecorationKey,
          state: {
            init(_, { doc }) {
              return buildDecorations(docName, doc);
            },
            apply(tr, decorations, _, newState) {
              if (tr.getMeta(documentCommentDecorationKey) === 'rebuild') {
                return buildDecorations(docName, newState.doc);
              }
              return decorations.map(tr.mapping, newState.doc);
            },
          },
          props: {
            decorations(state) {
              return this.getState(state) ?? DecorationSet.empty;
            },
            handleDOMEvents: {
              click(_, event) {
                const target = (event.target as Element | null)?.closest('[data-ok-comment-id]');
                if (!target) return false;
                const id = target.getAttribute('data-ok-comment-id');
                if (!id) return false;
                setActiveDocumentComment(docName, id);
                requestDocPanelTab('comments');
                return true;
              },
            },
          },
          view(view) {
            let destroyed = false;
            let scrollFrame = 0;
            let lastActiveCommentId = getDocumentCommentSnapshot(docName).activeCommentId;
            const scrollToActiveComment = (commentId: string | null) => {
              if (commentId === null) return;
              cancelAnimationFrame(scrollFrame);
              scrollFrame = requestAnimationFrame(() => {
                if (destroyed) return;
                const target = Array.from(
                  view.dom.querySelectorAll<HTMLElement>('[data-ok-comment-id]'),
                ).find((el) => el.getAttribute('data-ok-comment-id') === commentId);
                target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
              });
            };
            const unsubscribe = subscribeDocumentComments(() => {
              if (destroyed) return;
              view.dispatch(view.state.tr.setMeta(documentCommentDecorationKey, 'rebuild'));
              const activeCommentId = getDocumentCommentSnapshot(docName).activeCommentId;
              if (activeCommentId !== lastActiveCommentId) {
                lastActiveCommentId = activeCommentId;
                scrollToActiveComment(activeCommentId);
              }
            });
            return {
              destroy() {
                destroyed = true;
                cancelAnimationFrame(scrollFrame);
                unsubscribe();
              },
            };
          },
        }),
      ];
    },
  });
}
