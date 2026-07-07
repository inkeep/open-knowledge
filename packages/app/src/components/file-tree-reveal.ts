/** Imperative scroll applicator for the file tree's reveal-active-row effect. */

import type { FileTree as PierreFileTreeModel } from '@pierre/trees';

type RevealModel = Pick<PierreFileTreeModel, 'getFocusedPath' | 'scrollToPath'>;

/**
 * Scroll @pierre/trees' virtualized list so the just-activated (focused) row is
 * in view. `useSelectionMirror` sets the focused path on a programmatic open,
 * but Pierre only auto-scrolls a focused row when the tree owns DOM focus —
 * which a programmatic open never gives it — so the row can stay below the fold.
 * `scrollToPath` is Pierre's own imperative scroll (sticky-folder aware), called
 * with `focus: false` so the row is revealed without stealing DOM focus and
 * `offset: 'nearest'` so it scrolls the minimum distance. No-ops when there is
 * no focused row.
 */
export function revealActiveRow(model: RevealModel): void {
  const focusedPath = model.getFocusedPath();
  if (!focusedPath) return;
  model.scrollToPath(focusedPath, { offset: 'nearest', focus: false });
}
