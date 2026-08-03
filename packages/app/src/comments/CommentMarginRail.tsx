/**
 * Comment scrubber rail.
 *
 * A thin right-edge rail of small comment ICONS — one per open thread — each
 * sitting BESIDE the line it is anchored to. Clicking one scrolls to the passage
 * and opens its thread (via the shared open-thread bus → the click-at-text
 * popover).
 *
 * Position comes from `view.coordsAtPos`, i.e. where the text actually is on
 * screen, so an icon lines up with its own sentence. It deliberately does NOT
 * map a document fraction onto the pane: the scroll container also holds the
 * cover and the frontmatter table, which ProseMirror knows nothing about, so a
 * fraction of the BODY drawn over the whole PANE puts every marker above its
 * text by however tall the properties happen to be.
 *
 * Two adjustments keep it readable. Icons that would overlap are pushed down in
 * document order, so a cluster stacks instead of piling on one point. A comment
 * scrolled out of view clamps to the nearest edge and dims — it stops claiming
 * to point at a line, while still saying "there is more this way".
 *
 * The rail's top edge is the scrollport's top PLUS the inset that scrollport
 * declares, because the editor toolbar overlays that strip and its buttons are
 * flush right, in the rail's own column.
 *
 * Recomputes on scroll, thread changes, doc edits, and container resize.
 */

import { useLingui } from '@lingui/react/macro';
import type { Editor } from '@tiptap/react';
import { MessageSquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { getEditorView } from '@/editor/utils/get-editor-view';
import { cn } from '@/lib/utils';
import { buildTextIndex, findQuoteRange, findRangeInIndex } from './anchor-search';
import {
  propertyRowRect,
  revealPropertyValueRange,
  scrollPropertyRowIntoView,
} from './property-row-rect';
import { findScrollContainer, scrollAnchorIntoView, scrollportInsetTop } from './scroll-to-anchor';
import {
  clearActiveThread,
  emitOpenThreadPopover,
  setActiveThread,
  subscribeOpenThreadPopover,
  useCommentThreads,
} from './store';

const RAIL_WIDTH = 34;
const ICON_H = 30;
const GAP = 4;

interface RailBox {
  top: number;
  height: number;
  left: number;
}

interface MarkerPosition {
  id: string;
  top: number;
  /** The anchored line is scrolled out of view; the icon is clamped to an edge. */
  offscreen: boolean;
}

/**
 * The band of the scrollport a marker may occupy, in viewport coordinates.
 *
 * The scrollport reaches up UNDER the editor toolbar, and the toolbar's action
 * buttons sit flush against the same right edge the rail runs down — so a
 * marker clamped to the raw top of that box lands on top of them. Taking the
 * inset off the top uses the one number the scrollport already declares as
 * covered, instead of restating the toolbar's height here.
 */
export function railBand(
  rect: { top: number; height: number },
  insetTop: number,
): { top: number; height: number } {
  return { top: rect.top + insetTop, height: Math.max(0, rect.height - insetTop) };
}

/**
 * Place each marker beside its line, in viewport coordinates.
 *
 * Exported for test: this is the geometry that was wrong before — a marker's y
 * has to come from where the TEXT is, and everything here is about what happens
 * once it does. Pure so it can be checked without a laid-out editor.
 */
export function layoutMarkers(
  targets: readonly { id: string; y: number }[],
  railTop: number,
  railHeight: number,
): MarkerPosition[] {
  const ordered = [...targets].sort((a, b) => a.y - b.y);
  const maxTop = railTop + railHeight - ICON_H;
  const out: MarkerPosition[] = [];
  let prevBottom = railTop - GAP;
  for (const item of ordered) {
    const offscreen = item.y < railTop || item.y > railTop + railHeight;
    // Center on the line rather than hanging below its baseline.
    const wanted = item.y - ICON_H / 2;
    const top = Math.min(maxTop, Math.max(wanted, prevBottom + GAP, railTop));
    out.push({ id: item.id, top, offscreen });
    prevBottom = top + ICON_H;
  }
  return out;
}

export function CommentMarginRail({ editor, docName }: { editor: Editor; docName: string }) {
  const { t } = useLingui();
  const threads = useCommentThreads(docName);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [rail, setRail] = useState<RailBox | null>(null);
  const [positions, setPositions] = useState<MarkerPosition[]>([]);

  useEffect(() => subscribeOpenThreadPopover((id) => setActiveId(id)), []);

  useEffect(() => {
    const view = getEditorView(editor);
    if (!view) return;
    const container = findScrollContainer(view.dom);
    if (!container) return;
    // Both kinds, placed from different sources in one pass. A body thread's y
    // comes from ProseMirror; a property's comes from its row in the properties
    // table, which lives in this same scroll container. What a property must
    // never do is fall through to the quote search — its key would match
    // ordinary prose and put the marker on a passage nobody commented on.
    const open = threads.filter(
      (thread) =>
        thread.status === 'open' && (thread.target.kind === 'property' || thread.anchor !== null),
    );

    const compute = () => {
      const rect = container.getBoundingClientRect();
      const targets: { id: string; y: number }[] = [];
      if (open.length > 0) {
        // ONE index for the whole pass. `findQuoteRange` builds one internally,
        // so calling it per thread walked the entire document once per comment
        // — and this runs on every scroll frame and every edit. Measured at 40
        // comments in a 100k-character document that was ~35 ms a frame, about
        // twenty times what resolving them against a shared index costs.
        const index = buildTextIndex(editor.state.doc);
        for (const thread of open) {
          let y: number;
          if (thread.target.kind === 'property') {
            // Null when the properties disclosure is collapsed or the key is
            // gone — nothing on screen to sit beside, so no marker.
            const rect = propertyRowRect(thread.target.key);
            if (rect === null) continue;
            y = rect.top + rect.height / 2;
          } else {
            if (thread.anchor === null) continue;
            const range = findRangeInIndex(index, thread.anchor.quote, thread.anchor);
            if (range === null) continue;
            try {
              // Viewport coords of the anchored text itself. Throws for a position
              // ProseMirror has not laid out (mid-remount); skip rather than guess.
              y = view.coordsAtPos(range.from).top;
            } catch {
              continue;
            }
          }
          targets.push({ id: thread.id, y });
        }
      }
      const band = railBand(rect, scrollportInsetTop(container));
      setRail({ top: band.top, height: band.height, left: rect.right - RAIL_WIDTH });
      setPositions(layoutMarkers(targets, band.top, band.height));
    };

    compute();
    let frame = 0;
    const onChange = () => {
      // Scroll fires per frame; coalesce so a fast flick does one layout pass.
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        compute();
      });
    };
    window.addEventListener('resize', onChange);
    container.addEventListener('scroll', onChange, { passive: true });
    const observer = new ResizeObserver(onChange);
    observer.observe(container);
    editor.on('update', onChange);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener('resize', onChange);
      container.removeEventListener('scroll', onChange);
      observer.disconnect();
      editor.off('update', onChange);
    };
  }, [editor, threads]);

  function jumpTo(threadId: string) {
    // Second click on the marker you are already reading closes it. The rail
    // mirrors the popover's own state, so this stays right when the popover was
    // dismissed some other way (Escape, a click in the document).
    if (activeId === threadId) {
      emitOpenThreadPopover(null);
      return;
    }
    const thread = threads.find((x) => x.id === threadId);
    if (thread?.target.kind === 'property') {
      // Selecting the words is the only highlight a `<textarea>` can show. A
      // whole-field comment has no words, and a value passage whose text has
      // moved on falls back to the same place — the row itself.
      const revealed =
        thread.anchor !== null &&
        revealPropertyValueRange({
          key: thread.target.key,
          path: thread.target.path,
          quote: thread.anchor.quote,
          start: thread.anchor.start,
          end: thread.anchor.end,
        });
      if (!revealed) scrollPropertyRowIntoView(thread.target.key);
    } else if (thread && thread.anchor !== null) {
      const range = findQuoteRange(editor.state.doc, thread.anchor.quote, thread.anchor);
      if (range) scrollAnchorIntoView(editor, range);
    }
    emitOpenThreadPopover(threadId);
  }

  if (rail === null || positions.length === 0) return null;

  return createPortal(
    <div
      className="pointer-events-none fixed z-30"
      style={{ top: rail.top, height: rail.height, left: rail.left, width: RAIL_WIDTH }}
    >
      {positions.map((pos) => {
        const thread = threads.find((x) => x.id === pos.id);
        if (!thread) return null;
        const active = pos.id === activeId;
        return (
          <Button
            key={pos.id}
            type="button"
            variant="ghost"
            aria-label={active ? t`Close comment` : t`Open comment`}
            aria-expanded={active}
            className={cn(
              'pointer-events-auto absolute left-0 size-7 rounded-full border bg-background p-0 shadow-sm transition-colors hover:bg-muted',
              // Dimmed: it is parked at the edge, not pointing at the line beside it.
              pos.offscreen && 'opacity-40 hover:opacity-100',
              active && 'border-amber-500 bg-amber-50',
            )}
            style={{ top: pos.top - rail.top }}
            data-comment-thread={thread.id}
            onClick={() => jumpTo(thread.id)}
            // Which line a marker belongs to is otherwise a guess when several
            // stack up — hovering it deepens that comment's passage.
            onPointerEnter={() => setActiveThread(thread.id)}
            onPointerLeave={() => clearActiveThread(thread.id)}
          >
            <MessageSquare className="size-3.5 text-amber-500" />
          </Button>
        );
      })}
    </div>,
    document.body,
  );
}
