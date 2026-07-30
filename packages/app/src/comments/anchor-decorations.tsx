/**
 * Anchor-highlight layer — the marks on the passages that carry comments.
 *
 * Content-addressed: each thread re-finds its passage by matching its stored
 * quote against the live doc text on every redraw, never by a saved position. A
 * quote that no longer matches produces no decoration, which is how an orphaned
 * thread renders un-highlighted while still living in the panel.
 *
 * Pure-ProseMirror plugin plus a thin React host that registers it, mirroring
 * the deferred `editor.registerPlugin` pattern in TiptapEditor's agent-flash
 * effect.
 */

import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Editor } from '@tiptap/react';
import { useEffect } from 'react';
import { buildAnchorSegments, type PlacedAnchor } from './anchor-layers';
import { buildTextIndex, findRangeInIndex } from './anchor-search';
import {
  emitOpenThreadPopover,
  getActiveThread,
  getThreads,
  refresh,
  subscribe,
  subscribeActiveThread,
} from './store';

const commentAnchorKey = new PluginKey('okCommentAnchors');

// Only open threads are anchored in the doc — resolved threads drop their
// highlight + marker (they stay in the panel under "Show resolved"), so a
// clean document isn't littered with highlights on settled discussions.

/**
 * The passage a comment is being written ABOUT, held while the composer is open.
 *
 * Opening the composer moves focus into it, which drops the browser's selection
 * — so the words you picked stopped being visible at exactly the moment you were
 * describing them, and a multi-line pick gave no clue where it ended. This keeps
 * the same highlight a landed comment gets, so the passage reads as already
 * marked while you type.
 */
interface DraftRange {
  from: number;
  to: number;
}

/**
 * Highlight (or clear) the passage the comment composer is open on. Pass null on
 * cancel or post — the landed comment's own decoration takes over from there.
 */
export function setCommentDraftRange(editor: Editor, range: DraftRange | null): void {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(commentAnchorKey, { draft: range }));
}

function openThread(threadId: string): void {
  emitOpenThreadPopover(threadId);
}

/**
 * Resolve every open thread (plus the pending draft) to a live range. The draft
 * joins the same list rather than being layered on top, so commenting on text
 * that already carries a comment is styled as the overlap it is.
 */
function placeAnchors(docName: string, doc: PMNode, draft: DraftRange | null): PlacedAnchor[] {
  const placed: PlacedAnchor[] = [];
  // Property threads are excluded, not merely skipped downstream: they point at
  // a frontmatter key, which has no range in the body this decorates. Letting one
  // through would send its key name into the text search, where a key like
  // `title` matches ordinary prose and highlights a passage nobody commented on.
  const threads = getThreads(docName).filter(
    (t) => t.status === 'open' && t.target.kind === 'body' && t.anchor !== null,
  );
  if (threads.length > 0) {
    const index = buildTextIndex(doc);
    for (const thread of threads) {
      if (thread.anchor === null) continue;
      const range = findRangeInIndex(index, thread.anchor.quote, thread.anchor);
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

/**
 * The decorations are held in plugin state rather than rebuilt from the
 * `decorations` prop, so a transaction that cannot have moved a highlight can
 * hand back the previous set untouched.
 *
 * That is most of them. Every arrow key, click, and focus change dispatches a
 * transaction, and resolving every thread against a freshly built character
 * index on each one is real work — on a large document with a thread whose
 * quote no longer matches, re-resolving runs three full-document scans per
 * thread, per transaction.
 */
interface AnchorPluginState {
  draft: DraftRange | null;
  decorations: DecorationSet;
}

/**
 * What a transaction obliges the anchor layer to do.
 *
 * - `draft` — the composer set or cleared its pending highlight.
 * - `rebuild` — the document changed, or the store pinged us. Thread state lives
 *   outside editor state, so an edit, a resolve, or a change of active thread
 *   reaches this plugin only as a meta transaction and cannot be inferred.
 * - `reuse` — nothing that can move a highlight. Selection moves, clicks, and
 *   focus changes all land here, and they are the majority of transactions.
 */
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
            // Follow edits made while the composer is open rather than
            // highlighting whatever text has since slid into those positions.
            // A no-doc-change rebuild maps through an identity mapping.
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
        // Narrowest wins: clicking where two comments overlap opens the more
        // specific one rather than whichever thread the store happened to list
        // first.
        let hit: PlacedAnchor | null = null;
        for (const anchor of placeAnchors(docName, view.state.doc, null)) {
          if (anchor.id === null) continue;
          if (pos < anchor.from || pos > anchor.to) continue;
          if (hit === null || anchor.to - anchor.from < hit.to - hit.from) hit = anchor;
        }
        if (hit?.id == null) return false;
        openThread(hit.id);
        return true;
      },
    },
  });
}

/**
 * Registers the anchor plugin on the editor and re-triggers a redraw whenever
 * the comment store mutates (new thread, resolve, orphan re-place). Nothing
 * renders — it's a behavior-only host, like the agent-flash effect.
 */
export function CommentAnchorLayer({ editor, docName }: { editor: Editor; docName: string }) {
  useEffect(() => {
    let disposed = false;
    // Defer out of React's commit phase — registerPlugin reconfigures editor
    // state and can flushSync inside a lifecycle otherwise (same reason the
    // agent-flash effect uses queueMicrotask).
    queueMicrotask(() => {
      if (disposed || editor.isDestroyed) return;
      editor.registerPlugin(createCommentAnchorPlugin(docName));
      // Threads load from the server on first read; redraw once they land.
      void refresh(docName)
        .then(() => {
          if (disposed || editor.isDestroyed) return;
          editor.view.dispatch(editor.state.tr.setMeta(commentAnchorKey, { refresh: true }));
        })
        .catch(() => undefined);
    });

    // Force a decoration recompute on any store change (thread state is not
    // part of editor state, so a no-op meta transaction is how we redraw).
    // Which thread is active rides its own signal: pointing at a comment
    // restyles the document without disturbing anything reading the list.
    const redraw = () => {
      if (disposed || editor.isDestroyed) return;
      const view = (editor as unknown as { editorView?: typeof editor.view }).editorView;
      if (!view) return;
      view.dispatch(view.state.tr.setMeta(commentAnchorKey, { refresh: true }));
    };
    const unsubscribe = subscribe(redraw);
    const unsubscribeActive = subscribeActiveThread(redraw);

    return () => {
      disposed = true;
      unsubscribe();
      unsubscribeActive();
      if (!editor.isDestroyed) editor.unregisterPlugin(commentAnchorKey);
    };
  }, [editor, docName]);

  return null;
}
