/**
 * Pure placement math for restoring a project window to its persisted frame.
 * Sibling of `cascade-position.ts`: that module answers "where does a window
 * with NO memory go", this one answers "are the REMEMBERED bounds still
 * usable on the current display set". Both are Electron-free so tests can
 * exercise multi-monitor topologies directly.
 */

import type { PersistedWindowBounds } from './state-store.ts';

export interface PlacementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Minimum horizontal overlap between the saved frame and a display's work
 * area for the memory to count as "still on screen". Below this, the window
 * would restore as an unreachable sliver (e.g. the display it lived on was
 * unplugged and only a corner clips the remaining arrangement).
 */
export const MIN_VISIBLE_WIDTH_PX = 100;

/**
 * Vertical strip of the frame's top edge that must sit inside a work area so
 * the title bar stays grabbable. The top edge is the load-bearing part: a
 * window whose title bar is above the screen top (or below the bottom) can't
 * be dragged back by the user, which is the classic stale-bounds failure.
 */
export const TITLE_BAR_REACH_PX = 40;

export interface RestoredPlacement {
  /** Normal-state frame to apply, min-size-clamped. */
  bounds: PlacementRect;
  /** Re-enter maximized after the window is shown. */
  maximize: boolean;
  /** Re-enter native full-screen after the window is shown. */
  fullscreen: boolean;
}

/**
 * Decide whether persisted window bounds are restorable on the current
 * display arrangement. Returns the placement to apply, or `null` when there
 * is no memory or the remembered frame is not usably visible on any display
 * — callers fall back to cascade placement. The frame is used as-persisted
 * (no clamping/translation): if it passes the visibility gate the user can
 * reach it, and silently "repairing" positions is how windows drift to
 * unexpected displays. Width/height are clamped up to the window class's
 * minimum so a corrupt-but-parseable tiny frame can't restore below the
 * `BrowserWindow` min-size floor.
 */
export function resolveRestoredPlacement(input: {
  saved: PersistedWindowBounds | undefined;
  /** Work areas of every connected display (`screen.getAllDisplays()`). */
  workAreas: readonly PlacementRect[];
  minSize: { width: number; height: number };
}): RestoredPlacement | null {
  const { saved, workAreas, minSize } = input;
  if (!saved) return null;
  const width = Math.max(saved.width, minSize.width);
  const height = Math.max(saved.height, minSize.height);
  const usable = workAreas.some((workArea) => {
    const overlapWidth =
      Math.min(saved.x + width, workArea.x + workArea.width) - Math.max(saved.x, workArea.x);
    const titleBarReachable =
      saved.y >= workArea.y && saved.y <= workArea.y + workArea.height - TITLE_BAR_REACH_PX;
    return overlapWidth >= MIN_VISIBLE_WIDTH_PX && titleBarReachable;
  });
  if (!usable) return null;
  return {
    bounds: { x: saved.x, y: saved.y, width, height },
    maximize: saved.isMaximized,
    fullscreen: saved.isFullScreen,
  };
}

/**
 * Stable ascending sort of project paths by focus sequence — least recently
 * focused first, MOST recently focused last. Paths with no recorded focus
 * (never focused this session) sort first, keeping their relative order.
 * Orders the `pendingWindowRestore` snapshot so the restoring boot can raise
 * the last entry and land the user in the window they were working in.
 */
export function sortByFocusSequence(
  paths: readonly string[],
  focusSeq: ReadonlyMap<string, number>,
): string[] {
  return [...paths].sort((a, b) => (focusSeq.get(a) ?? 0) - (focusSeq.get(b) ?? 0));
}
