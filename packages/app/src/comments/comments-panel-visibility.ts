/**
 * Whether the Comments tab is genuinely ON SCREEN — its tab selected in the doc
 * panel AND the right rail expanded.
 *
 * Read by surfaces that offer a route TO the queue, so the offer can be dropped
 * when the reader is already looking at it. The selection composer is the first:
 * a "View comments" button beside "Add comment" is a second control competing
 * with the primary one, and pressing it while the panel is open does nothing
 * visible at all.
 *
 * Mount lifetime is NOT the answer, which is why this is not folded into
 * `visible-scope`: a collapsed rail keeps the whole doc-panel subtree mounted at
 * zero width, so "the tab is rendered" reports true while nothing is visible.
 * The publisher composes the expanded state in, and the panel is the publisher
 * because it is what resolves the EFFECTIVE tab (single-file mode drops
 * Comments, so a persisted selection can name a tab that is not there).
 *
 * Subscribable, unlike `visible-scope`'s plain slot, because this reader is a
 * rendered control that has to appear and disappear with the answer rather than
 * a keydown handler asking once at the moment of the press.
 */

import { useSyncExternalStore } from 'react';

let onScreen = false;
const listeners = new Set<() => void>();

export function setCommentsPanelOnScreen(next: boolean): void {
  if (next === onScreen) return;
  onScreen = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): boolean {
  return onScreen;
}

export function useCommentsPanelOnScreen(): boolean {
  // Server snapshot is `false`: with no panel rendered there is nothing on
  // screen, so a route to it is the right thing to offer.
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
