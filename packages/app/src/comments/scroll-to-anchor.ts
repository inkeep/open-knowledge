import type { Editor } from '@tiptap/react';
import { runScrollNavigation } from '@/editor/scroll-restore-coordination';
import { getEditorView } from '@/editor/utils/get-editor-view';

const BOTTOM_ROOM_PX = 220;

const LEAD_PX = 24;

export interface AnchorViewport {
  anchorTop: number;
  anchorBottom: number;
  viewTop: number;
  viewBottom: number;
  insetTop: number;
}

export function scrollDeltaForAnchor(v: AnchorViewport): number {
  const restTop = v.viewTop + v.insetTop;
  const restBottom = v.viewBottom - BOTTOM_ROOM_PX;
  if (v.anchorTop >= restTop && v.anchorBottom <= restBottom) return 0;
  return v.anchorTop - (restTop + LEAD_PX);
}

export function findScrollContainer(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
    node = node.parentElement;
  }
  return null;
}

export function scrollportInsetTop(container: HTMLElement): number {
  const value = Number.parseFloat(getComputedStyle(container).scrollPaddingTop);
  return Number.isFinite(value) ? value : 0;
}

export function scrollAnchorIntoView(
  editor: Editor,
  range: { from: number; to: number },
  docName: string,
  opts?: {
    instant?: boolean;
  },
): boolean {
  const view = getEditorView(editor);
  if (!view) return false;
  const container = findScrollContainer(view.dom);
  if (!container) {
    return runScrollNavigation(docName, 'comment-reveal', () => editor.commands.scrollIntoView());
  }
  let start: { top: number; bottom: number };
  let end: { top: number; bottom: number };
  try {
    start = view.coordsAtPos(range.from);
    end = view.coordsAtPos(range.to);
  } catch {
    return false;
  }
  const box = container.getBoundingClientRect();
  const delta = scrollDeltaForAnchor({
    anchorTop: start.top,
    anchorBottom: Math.max(start.bottom, end.bottom),
    viewTop: box.top,
    viewBottom: box.bottom,
    insetTop: scrollportInsetTop(container),
  });
  if (delta === 0) return true;
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  return runScrollNavigation(docName, 'comment-reveal', () =>
    container.scrollTo({
      top: container.scrollTop + delta,
      behavior: opts?.instant || reduceMotion ? 'auto' : 'smooth',
    }),
  );
}
