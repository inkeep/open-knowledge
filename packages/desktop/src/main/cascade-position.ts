/**
 * Cascade placement for editor windows. Without an explicit position Electron
 * centers every new BrowserWindow, so multi-window opens (most visibly the
 * post-update relaunch restoring N projects) stack dead-center and read as a
 * single window. macOS document apps solve this by offsetting each new window
 * down-right from the previous one; this module is the pure math for that.
 */

/** Down-right step between cascaded windows, in px. */
export const CASCADE_OFFSET_PX = 28;

interface CascadeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CascadeInput {
  /** Current top-left of the window to cascade from; null when this is the first window. */
  anchor: { x: number; y: number } | null;
  /** Outer frame size of the window being placed. */
  size: { width: number; height: number };
  /** Work area of the display the anchor window lives on. */
  workArea: CascadeRect;
}

/**
 * Top-left position for a new window cascaded off `anchor`, or null when
 * there is no anchor (caller keeps Electron's default centered placement).
 * When the offset position would push the window past the work area's right
 * or bottom edge, the cascade wraps back to the work area's top-left so long
 * runs of windows stay reachable instead of marching off-screen.
 */
export function cascadePosition(input: CascadeInput): { x: number; y: number } | null {
  const { anchor, size, workArea } = input;
  if (anchor === null) return null;

  const x = anchor.x + CASCADE_OFFSET_PX;
  const y = anchor.y + CASCADE_OFFSET_PX;
  const fitsRight = x + size.width <= workArea.x + workArea.width;
  const fitsBottom = y + size.height <= workArea.y + workArea.height;
  if (fitsRight && fitsBottom) return { x, y };

  return { x: workArea.x + CASCADE_OFFSET_PX, y: workArea.y + CASCADE_OFFSET_PX };
}
