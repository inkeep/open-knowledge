/**
 * Comment scrubber rail.
 *
 * A thin right-edge rail of small comment ICONS — one per open thread — each
 * sitting BESIDE the line it is anchored to. Clicking one scrolls to the passage
 * and opens its thread — which is to say it brings that comment up in the
 * Comments panel (via the shared open-thread bus), rather than floating a card
 * over the words the reader came to read.
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

// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import { useLingui } from '@lingui/react/macro';
import type { Editor } from '@tiptap/react';
import { MessageSquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { getEditorView } from '@/editor/utils/get-editor-view';
import { cn } from '@/lib/utils';
import { createAnchorResolver, findQuoteRange } from './anchor-search';
import {
  propertyRowRect,
  revealPropertyValueRange,
  scrollPropertyRowIntoView,
} from './property-row-rect';
import { findScrollContainer, scrollAnchorIntoView, scrollportInsetTop } from './scroll-to-anchor';
import {
  clearActiveThread,
  emitOpenThread,
  setActiveThread,
  useCommentThreads,
  useOpenThread,
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
 * Narrower than this and the rail is covering the text instead of sitting beside
 * it, so it does not draw at all. Roughly the width below which the editor's own
 * measure has collapsed to a few words a line.
 */
const MIN_PANE_WIDTH = 260;

/**
 * Where the rail's left edge goes, or null when the pane is too narrow to host
 * one.
 *
 * The rail is a FIXED portal on `document.body`, so no ancestor's overflow can
 * clip it — it has to sit over the scroll area without scrolling with it, and
 * the cost of that is that whatever `left` it computes is where it paints, over
 * whatever happens to be there. The scroll container's own right edge is not a
 * safe answer: squeezed past its minimum the container keeps its width and
 * overflows the pane clipping it, and the rail followed it into the next panel.
 *
 * So the edge comes from the nearest thing that actually clips, and the rail
 * declines rather than shrinking — a 34px rail inside a 200px pane is on top of
 * the prose either way, and half a marker peeking out reads as breakage.
 */
export function railLeft(rect: { left: number; right: number }, clipRight: number): number | null {
  const right = Math.min(rect.right, clipRight);
  if (right - rect.left < MIN_PANE_WIDTH) return null;
  return right - RAIL_WIDTH;
}

/**
 * The viewport x of the nearest ancestor that clips horizontally — the pane's
 * real right edge, whatever the scroll container believes about its own width.
 * Falls back to the viewport, which clips everything.
 */
function horizontalClipRight(el: HTMLElement): number {
  let node: HTMLElement | null = el.parentElement;
  while (node) {
    if (getComputedStyle(node).overflowX !== 'visible') {
      return node.getBoundingClientRect().right;
    }
    node = node.parentElement;
  }
  return window.innerWidth;
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
  // Read from the store rather than held locally and fed by a subscription.
  // Local state starts at null and only learns from the NEXT event, so a rail
  // that mounts while a thread is already open — the editor pool recycles this
  // component on every visit to a document — drew its marker unlit and then got
  // the toggle backwards: `jumpTo` compares against this value, so the first
  // click on the lit marker re-opened the thread instead of closing it.
  const activeId = useOpenThread();
  const [rail, setRail] = useState<RailBox | null>(null);
  const [positions, setPositions] = useState<MarkerPosition[]>([]);

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
        // ONE resolver for the whole pass — see `createAnchorResolver`, which
        // owns the shared-index reasoning and the prose-before-components order.
        const resolve = createAnchorResolver(editor.state.doc);
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
            const range = resolve(thread.anchor.quote, thread.anchor);
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
      const left = railLeft(rect, horizontalClipRight(container));
      if (left === null) {
        // Both, not just the rail: the markers are absolutely positioned inside
        // it, so leaving them behind would strand a list with nothing to hang on.
        setRail(null);
        setPositions([]);
        return;
      }
      const band = railBand(rect, scrollportInsetTop(container));
      setRail({ top: band.top, height: band.height, left });
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
    // Second click on the marker you are already reading stands the thread
    // down. The rail mirrors the open-thread state rather than keeping its own,
    // so this stays right when the thread was closed from somewhere else.
    if (activeId === threadId) {
      emitOpenThread(null);
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
      if (range) scrollAnchorIntoView(editor, range, thread.docName);
    }
    emitOpenThread(threadId);
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
            // The label carries the state on its own. No `aria-expanded`: this
            // marker no longer unfolds anything beside itself — it shows the
            // comment in the Comments panel, a region it does not own — and a
            // button claiming a collapsed disclosure that is not there sends a
            // screen-reader user looking for one.
            aria-label={active ? t`Close comment` : t`Open comment`}
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
