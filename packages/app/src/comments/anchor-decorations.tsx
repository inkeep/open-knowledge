import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Editor } from '@tiptap/react';
import { useEffect } from 'react';
import { buildAnchorSegments, type PlacedAnchor } from './anchor-layers';
import { createAnchorResolver } from './anchor-search';
import {
  emitOpenThread,
  getActiveThread,
  getOpenThread,
  getThreads,
  refresh,
  subscribe,
  subscribeActiveThread,
} from './store';

const commentAnchorKey = new PluginKey('okCommentAnchors');

interface DraftRange {
  from: number;
  to: number;
}

export function setCommentDraftRange(editor: Editor, range: DraftRange | null): void {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(commentAnchorKey, { draft: range }));
}

function openThread(threadId: string): void {
  emitOpenThread(threadId);
}

function standDown(): void {
  if (getOpenThread() === null) return;
  emitOpenThread(null);
}

function placeAnchors(docName: string, doc: PMNode, draft: DraftRange | null): PlacedAnchor[] {
  const placed: PlacedAnchor[] = [];
  const threads = getThreads(docName).filter(
    (t) => t.status === 'open' && t.target.kind === 'body' && t.anchor !== null,
  );
  if (threads.length > 0) {
    const resolve = createAnchorResolver(doc);
    for (const thread of threads) {
      if (thread.anchor === null) continue;
      const range = resolve(thread.anchor.quote, thread.anchor);
      if (range === null) continue;
      placed.push({ id: thread.id, from: range.from, to: range.to });
    }
  }
  if (draft !== null && draft.from < draft.to) {
    placed.push({ id: null, from: draft.from, to: draft.to });
  }
  return placed;
}

function buildDecorations(docName: string, doc: PMNode, draft: DraftRange | null): DecorationSet {
  const placed = placeAnchors(docName, doc, draft);
  if (placed.length === 0) return DecorationSet.empty;
  const decos: Decoration[] = buildAnchorSegments(placed, getActiveThread()).map((segment) =>
    Decoration.inline(
      segment.from,
      segment.to,
      segment.threadId === null
        ? { style: segment.style }
        : { style: segment.style, 'data-comment-thread': segment.threadId },
    ),
  );
  return DecorationSet.create(doc, decos);
}

interface AnchorPluginState {
  draft: DraftRange | null;
  decorations: DecorationSet;
}

export function anchorTransactionEffect(
  tr: { docChanged: boolean },
  meta: unknown,
): 'draft' | 'rebuild' | 'reuse' {
  if (typeof meta === 'object' && meta !== null && 'draft' in meta) return 'draft';
  if (tr.docChanged) return 'rebuild';
  return meta === undefined ? 'reuse' : 'rebuild';
}

function createCommentAnchorPlugin(docName: string): Plugin<AnchorPluginState> {
  return new Plugin<AnchorPluginState>({
    key: commentAnchorKey,
    state: {
      init: (_config, state) => ({
        draft: null,
        decorations: buildDecorations(docName, state.doc, null),
      }),
      apply(tr, previous, _oldState, newState) {
        const meta = tr.getMeta(commentAnchorKey);
        switch (anchorTransactionEffect(tr, meta)) {
          case 'reuse':
            return previous;
          case 'draft': {
            const draft = (meta as { draft: DraftRange | null }).draft;
            return { draft, decorations: buildDecorations(docName, newState.doc, draft) };
          }
          default: {
            const draft =
              previous.draft === null
                ? null
                : {
                    from: tr.mapping.map(previous.draft.from),
                    to: tr.mapping.map(previous.draft.to),
                  };
            return { draft, decorations: buildDecorations(docName, newState.doc, draft) };
          }
        }
      },
    },
    props: {
      decorations(state) {
        return commentAnchorKey.getState(state)?.decorations;
      },
      handleClick(view, pos) {
        let hit: PlacedAnchor | null = null;
        for (const anchor of placeAnchors(docName, view.state.doc, null)) {
          if (anchor.id === null) continue;
          if (pos < anchor.from || pos > anchor.to) continue;
          if (hit === null || anchor.to - anchor.from < hit.to - hit.from) hit = anchor;
        }
        if (hit?.id == null) {
          standDown();
          return false;
        }
        openThread(hit.id);
        return false;
      },
    },
  });
}

export function CommentAnchorLayer({ editor, docName }: { editor: Editor; docName: string }) {
  useEffect(() => {
    let disposed = false;
    queueMicrotask(() => {
      if (disposed || editor.isDestroyed) return;
      editor.registerPlugin(createCommentAnchorPlugin(docName));
      void refresh(docName)
        .then(() => {
          if (disposed || editor.isDestroyed) return;
          editor.view.dispatch(editor.state.tr.setMeta(commentAnchorKey, { refresh: true }));
        })
        .catch(() => undefined);
    });

    const redraw = () => {
      if (disposed || editor.isDestroyed) return;
      const view = (editor as unknown as { editorView?: typeof editor.view }).editorView;
      if (!view) return;
      view.dispatch(view.state.tr.setMeta(commentAnchorKey, { refresh: true }));
    };
    const unsubscribe = subscribe(redraw);
    const unsubscribeActive = subscribeActiveThread(redraw);

    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      standDown();
    };
    document.addEventListener('keydown', onEscape);

    return () => {
      disposed = true;
      unsubscribe();
      unsubscribeActive();
      document.removeEventListener('keydown', onEscape);
      if (!editor.isDestroyed) editor.unregisterPlugin(commentAnchorKey);
    };
  }, [editor, docName]);

  return null;
}
