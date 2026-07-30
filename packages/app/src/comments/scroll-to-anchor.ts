/**
 * Scroll a comment's passage somewhere you can actually read it.
 *
 * Two things went wrong before, both of which land the passage at an edge:
 *
 * ProseMirror's own `scrollIntoView` does minimal scroll-arithmetic against the
 * scrollport's box and, like CM6, does not read `scroll-padding-top` off the
 * scroll ancestor — so the passage stops flush against the top, underneath the
 * floating toolbar. And `Element.scrollIntoView({ block: 'center' })` centers
 * the BLOCK the passage sits in: for a long code fence or a table taller than
 * the viewport, centering the block says nothing about where the quoted line
 * ends up, which can be off-screen entirely.
 *
 * So: work from the passage's own coordinates, honour the inset the scrollport
 * declares, and keep room beneath it for the thread card that opens there.
 */

import type { Editor } from '@tiptap/react';
import { getEditorView } from '@/editor/utils/get-editor-view';

/**
 * Room left below the passage for the thread popover, which opens under it.
 * Generous on purpose — landing the passage on the last visible line puts its
 * card off-screen, which is the failure this whole module exists to prevent.
 */
const CARD_ROOM_PX = 220;

/** Breathing room below the toolbar when we do move, so it isn't flush. */
const LEAD_PX = 24;

export interface AnchorViewport {
  /** The passage, in viewport coordinates. */
  anchorTop: number;
  anchorBottom: number;
  /** The scrollport, in viewport coordinates. */
  viewTop: number;
  viewBottom: number;
  /** Top strip of the scrollport hidden behind the floating toolbar. */
  insetTop: number;
}

/**
 * How far to move `scrollTop`; `0` to leave it alone.
 *
 * Leaving a comfortably-placed passage alone matters as much as moving a badly
 * placed one: clicking through a list of comments on the same paragraph should
 * not jolt the page for each one.
 */
export function scrollDeltaForAnchor(v: AnchorViewport): number {
  const restTop = v.viewTop + v.insetTop;
  const restBottom = v.viewBottom - CARD_ROOM_PX;
  if (v.anchorTop >= restTop && v.anchorBottom <= restBottom) return 0;
  return v.anchorTop - (restTop + LEAD_PX);
}

/** Nearest scrollable ancestor of the editor content. */
export function findScrollContainer(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * Read the inset from the scrollport itself rather than restating the toolbar
 * height here — one fewer constant to keep in sync with `scroll-pt-14`.
 */
function insetTopOf(container: HTMLElement): number {
  const value = Number.parseFloat(getComputedStyle(container).scrollPaddingTop);
  return Number.isFinite(value) ? value : 0;
}

/** Bring a comment's passage into a readable position, with room for its card. */
export function scrollAnchorIntoView(editor: Editor, range: { from: number; to: number }): void {
  const view = getEditorView(editor);
  if (!view) return;
  const container = findScrollContainer(view.dom);
  // No scrollport of our own to drive (an embedded or content-sized editor):
  // ProseMirror's minimal scroll is still better than not moving at all.
  if (!container) {
    editor.commands.scrollIntoView();
    return;
  }
  let start: { top: number; bottom: number };
  let end: { top: number; bottom: number };
  try {
    // Throws for a position ProseMirror has not laid out yet (mid-remount).
    start = view.coordsAtPos(range.from);
    end = view.coordsAtPos(range.to);
  } catch {
    return;
  }
  const box = container.getBoundingClientRect();
  const delta = scrollDeltaForAnchor({
    anchorTop: start.top,
    anchorBottom: Math.max(start.bottom, end.bottom),
    viewTop: box.top,
    viewBottom: box.bottom,
    insetTop: insetTopOf(container),
  });
  if (delta === 0) return;
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  container.scrollTo({
    top: container.scrollTop + delta,
    behavior: reduceMotion ? 'auto' : 'smooth',
  });
}
