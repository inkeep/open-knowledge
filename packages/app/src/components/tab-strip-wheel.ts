import type { WheelEvent } from 'react';

export function scrollTabStripOnWheel(event: WheelEvent<HTMLElement>): void {
  if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
  if (event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) return;
  event.preventDefault();
  event.currentTarget.scrollLeft += event.deltaY;
}
