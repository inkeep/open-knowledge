import {
  type PersistedWindowBounds,
  type RestoredWindow,
  windowRestoreKey,
} from './state-store.ts';

export interface PlacementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MIN_VISIBLE_WIDTH_PX = 100;

export const TITLE_BAR_REACH_PX = 40;

export interface RestoredPlacement {
  bounds: PlacementRect;
  maximize: boolean;
  fullscreen: boolean;
}

export function resolveRestoredPlacement(input: {
  saved: PersistedWindowBounds | undefined;
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

export function sortWindowsByFocusSequence(
  windows: readonly RestoredWindow[],
  focusSeq: ReadonlyMap<string, number>,
): RestoredWindow[] {
  return [...windows].sort(
    (a, b) => (focusSeq.get(windowRestoreKey(a)) ?? 0) - (focusSeq.get(windowRestoreKey(b)) ?? 0),
  );
}
