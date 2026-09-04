export interface PointerPosition {
  readonly x: number;
  readonly y: number;
}

let lastX = 0;
let lastY = 0;
let known = false;
let installed: (() => void) | null = null;

export function installPointerPositionTracker(): () => void {
  if (typeof window === 'undefined') return () => {};
  if (installed !== null) return installed;
  const controller = new AbortController();
  const listenerOptions = { passive: true, signal: controller.signal };
  window.addEventListener(
    'pointermove',
    (event: PointerEvent) => {
      lastX = event.clientX;
      lastY = event.clientY;
      known = true;
    },
    listenerOptions,
  );
  window.addEventListener(
    'pointerout',
    (event: PointerEvent) => {
      if (event.relatedTarget === null) known = false;
    },
    listenerOptions,
  );
  installed = () => {
    controller.abort();
    known = false;
    installed = null;
  };
  return installed;
}

export function getLastPointerPosition(): PointerPosition | null {
  return known ? { x: lastX, y: lastY } : null;
}
