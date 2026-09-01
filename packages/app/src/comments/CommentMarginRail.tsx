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
  offscreen: boolean;
}

export function railBand(
  rect: { top: number; height: number },
  insetTop: number,
): { top: number; height: number } {
  return { top: rect.top + insetTop, height: Math.max(0, rect.height - insetTop) };
}

const MIN_PANE_WIDTH = 260;

export function railLeft(rect: { left: number; right: number }, clipRight: number): number | null {
  const right = Math.min(rect.right, clipRight);
  if (right - rect.left < MIN_PANE_WIDTH) return null;
  return right - RAIL_WIDTH;
}

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
  const activeId = useOpenThread();
  const [rail, setRail] = useState<RailBox | null>(null);
  const [positions, setPositions] = useState<MarkerPosition[]>([]);

  useEffect(() => {
    const view = getEditorView(editor);
    if (!view) return;
    const container = findScrollContainer(view.dom);
    if (!container) return;
    const open = threads.filter(
      (thread) =>
        thread.status === 'open' && (thread.target.kind === 'property' || thread.anchor !== null),
    );

    const compute = () => {
      const rect = container.getBoundingClientRect();
      const targets: { id: string; y: number }[] = [];
      if (open.length > 0) {
        const resolve = createAnchorResolver(editor.state.doc);
        for (const thread of open) {
          let y: number;
          if (thread.target.kind === 'property') {
            const rect = propertyRowRect(thread.target.key);
            if (rect === null) continue;
            y = rect.top + rect.height / 2;
          } else {
            if (thread.anchor === null) continue;
            const range = resolve(thread.anchor.quote, thread.anchor);
            if (range === null) continue;
            try {
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
    if (activeId === threadId) {
      emitOpenThread(null);
      return;
    }
    const thread = threads.find((x) => x.id === threadId);
    if (thread?.target.kind === 'property') {
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
            aria-label={active ? t`Close comment` : t`Open comment`}
            className={cn(
              'pointer-events-auto absolute left-0 size-7 rounded-full border bg-background p-0 shadow-sm transition-colors hover:bg-muted',
              pos.offscreen && 'opacity-40 hover:opacity-100',
              active && 'border-blue-600 bg-blue-50 dark:border-blue-500 dark:bg-blue-950',
            )}
            style={{ top: pos.top - rail.top }}
            data-comment-thread={thread.id}
            onClick={() => jumpTo(thread.id)}
            onPointerEnter={() => setActiveThread(thread.id)}
            onPointerLeave={() => clearActiveThread(thread.id)}
          >
            <MessageSquare className="size-3.5 text-blue-600 dark:text-blue-400" />
          </Button>
        );
      })}
    </div>,
    document.body,
  );
}
