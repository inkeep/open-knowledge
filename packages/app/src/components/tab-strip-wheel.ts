import type { WheelEvent } from 'react';

/**
 * Remap a vertical mouse-wheel gesture to horizontal scroll on an overflow-x
 * tab strip, so a plain (vertical) wheel scrolls the tabs sideways — matching
 * the trackpad-horizontal / side-wheel behavior the browser already handles.
 * No-ops when the gesture is already horizontal (let the browser scroll it) or
 * the strip doesn't overflow. Shared by the editor tabs and the dock's
 * terminal/agent tab strip so both behave identically.
 */
export function scrollTabStripOnWheel(event: WheelEvent<HTMLElement>): void {
  if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
  if (event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) return;
  event.preventDefault();
  event.currentTarget.scrollLeft += event.deltaY;
}
