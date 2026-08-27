/**
 * Last-known pointer position, so a bug-report screenshot can show where the
 * cursor was.
 *
 * `capturePage()` never includes the cursor, so a report filed about a hover
 * state arrives as a highlighted row with nothing in the picture to explain
 * what highlighted it. The report gate reads this position a frame before it
 * shoots and draws a marker there.
 *
 * The answer is deliberately absent rather than approximated in the two cases
 * where the app has none: before the pointer has moved at all (a window
 * reached by keyboard), and once it has left the viewport — a marker pinned to
 * the edge the pointer exited would claim a hover the user is not making.
 */

export interface PointerPosition {
  /** Viewport coordinates, matching `PointerEvent.clientX` / `clientY`. */
  readonly x: number;
  readonly y: number;
}

// Held as primitives, and boxed only on read: `pointermove` fires up to a
// hundred times a second whenever the pointer is in motion, and this listener
// is app-global, while a read happens once per bug report.
let lastX = 0;
let lastY = 0;
let known = false;
/** The live tracker's disposer, or null when nothing is listening. */
let installed: (() => void) | null = null;

/**
 * Start tracking. Returns a disposer that also forgets the position: with no
 * listener running, what is held is not a last-known position but a stale one.
 *
 * No-op off the browser, matching `overlay-layers.ts` — the node-env test tiers
 * and any SSR pass import this module without a `window` to listen on.
 */
export function installPointerPositionTracker(): () => void {
  if (typeof window === 'undefined') return () => {};
  // A second install would leave two listener pairs live, and the FIRST
  // disposer would then clear the position out from under the second — so the
  // tracker would look installed and report nothing. Same guard the sibling
  // module-global installers carry (`relaunch-store`, `receive-store`).
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
      // A non-null `relatedTarget` is the pointer crossing between two
      // elements inside the window, which changes nothing about where it is.
      // Null is the predicate for "there is no element it went to", which is
      // how leaving the window presents — and also, per the Pointer Events
      // event list, how a `pointerup` on a device without hover and a
      // resolved removal of the element underneath present. Those degrade to
      // a marker that is absent rather than one drawn somewhere wrong, which
      // is the direction this module errs in everywhere else.
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
