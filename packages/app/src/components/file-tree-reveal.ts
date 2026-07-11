/** Imperative scroll applicator for the file tree's reveal-active-row effect. */

import type { FileTree as PierreFileTreeModel } from '@pierre/trees';

type RevealModel = Pick<PierreFileTreeModel, 'getFocusedPath' | 'scrollToPath'>;

/**
 * Scroll @pierre/trees' virtualized list so the just-activated row is in view.
 * `useSelectionMirror` sets the focused path on a programmatic open, but
 * Pierre only auto-scrolls a focused row when the tree owns DOM focus — which
 * a programmatic open never gives it — so the row can stay below the fold.
 * `scrollToPath` is Pierre's own imperative scroll (sticky-folder aware),
 * called with `focus: false` so the row is revealed without stealing DOM focus
 * and `offset: 'nearest'` so it scrolls the minimum distance.
 *
 * Scrolls only when the focused row IS the active row. When the active doc has
 * no visible row (e.g. hidden by a view filter), the mirror cannot move focus
 * off the previously active row — Pierre has no unfocus API — so the focused
 * path is a stale leftover, and scrolling to it would yank the tree to a row
 * that is not the open document. No-ops in that case (and when nothing is
 * focused).
 */
export function revealActiveRow(model: RevealModel, activeTreePath: string): void {
  if (model.getFocusedPath() !== activeTreePath) return;
  model.scrollToPath(activeTreePath, { offset: 'nearest', focus: false });
}
