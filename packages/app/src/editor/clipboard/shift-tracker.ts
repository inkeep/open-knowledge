/**
 * Track whether Shift was held on the most recent keyboard event so the
 * paste dispatcher can detect Cmd/Ctrl+Shift+V reliably.
 *
 * Why this exists: the `ClipboardEvent` type is NOT a `UIEvent` descendant
 * and does NOT expose `shiftKey` — reading `event.shiftKey` off the paste
 * event returns `undefined` in every real browser. The spec-compliant way
 * to detect Shift at paste time is to observe the preceding `KeyboardEvent`
 * and latch its modifier state; that's what PM does internally
 * (`view.input.shiftKey`, `prosemirror-view/src/input.ts:108`).
 *
 * We attach a single pair of `keydown` / `keyup` listeners to the window
 * (capture phase) on first read. The listeners run for every key event in
 * the page, but the work is trivial (a boolean assignment). The state is
 * cleared on `keyup` of Shift itself or on window blur so a paste triggered
 * from a context menu after shift was released does not get a stale latch.
 *
 * Synthetic events dispatched from test harnesses (Playwright, jsdom) may
 * attach a `shiftKey` property directly to the ClipboardEvent via
 * `Object.defineProperty`. The `pasteShiftHeld(event)` helper accepts both
 * channels so tests that relied on the old property-injection path still
 * work.
 */

let shiftHeldLatch = false;
let listenersAttached = false;

function onKeyDown(e: KeyboardEvent): void {
  shiftHeldLatch = e.shiftKey;
}

function onKeyUp(e: KeyboardEvent): void {
  // Clear when the Shift key itself is released, or when the event reports
  // no modifier state anymore.
  if (e.key === 'Shift' || !e.shiftKey) {
    shiftHeldLatch = false;
  }
}

function onBlur(): void {
  // Release the latch when the window loses focus — otherwise Alt+Tab with
  // Shift held would leave the latch permanently set until a subsequent
  // keyup inside our window.
  shiftHeldLatch = false;
}

function ensureAttached(): void {
  if (listenersAttached) return;
  if (typeof window === 'undefined') return;
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', onBlur, true);
  listenersAttached = true;
}

/**
 * Install the shift listeners. Safe to call many times — the listeners
 * are attached once. Call this at editor-creation time so the very first
 * paste in a session is not missed.
 */
export function installShiftTracker(): void {
  ensureAttached();
}

/**
 * True if Shift was held at the most recent keyboard event (keydown or
 * keyup). Installs the listeners lazily on first call.
 */
export function isShiftHeld(): boolean {
  ensureAttached();
  return shiftHeldLatch;
}

/**
 * Returns true if a paste event should be treated as Cmd+Shift+V.
 *
 * Checks two channels:
 *   1. The tracker latch from the preceding keyboard event (real browsers).
 *   2. A non-standard `shiftKey` property on the ClipboardEvent that some
 *      test harnesses inject via `Object.defineProperty` (Playwright).
 *
 * Both channels return false → false. Either true → true.
 */
export function pasteShiftHeld(event: ClipboardEvent): boolean {
  if (isShiftHeld()) return true;
  const injected = (event as unknown as { shiftKey?: boolean }).shiftKey;
  return injected === true;
}
