/**
 * Runtime toggle for a desktop window's Chromium background-throttling, keyed
 * to whether the window holds unsynced work.
 *
 * Chromium throttles animations and timers in a backgrounded window by default
 * (Electron `backgroundThrottling: true`). That default starves the CRDT sync
 * and recovery loop exactly when a backgrounded window still has edits to
 * flush. The renderer reports its unsynced state; main keeps timers alive
 * (`setBackgroundThrottling(false)`) only while work is pending, and restores
 * the OS-default throttling the moment the window is clean.
 *
 * The default is never disabled statically: `setBackgroundThrottling(false)`
 * also disables the Page Visibility API (visibilitychange / presence), so a
 * permanently-unthrottled window would break the flush-on-hide and presence
 * paths that depend on those events. The toggle returns to the OS default
 * whenever `hasPendingWork` is false — see `computeBackgroundThrottlingAllowed`.
 *
 * Ownership: the desktop app is the Chromium embedder, so the policy (the
 * predicate) lives here in main, keyed off a signal only the renderer can
 * observe (per-doc unsynced state). The kill-switch travels in the signal so a
 * disabled config resolves to the OS default uniformly through the same
 * predicate.
 */

export interface BackgroundThrottleSignal {
  /** True while any open doc in the window has work the server has not yet acked. */
  hasPendingWork: boolean;
  /** The `bridge.backgroundThrottle.enabled` kill-switch, resolved renderer-side. */
  enabled: boolean;
}

/**
 * The value to pass to `webContents.setBackgroundThrottling(allowed)`:
 * `true` = throttling allowed (the OS default), `false` = keep timers alive.
 *
 * Throttling is suppressed only when the mechanism is enabled AND the window
 * has pending work; every other case restores the OS default. In particular
 * `hasPendingWork === false` always yields `true`, so the toggle can never
 * leave a window permanently unthrottled — that would break the Page
 * Visibility API the flush-on-hide and presence paths depend on.
 */
export function computeBackgroundThrottlingAllowed(signal: BackgroundThrottleSignal): boolean {
  return !(signal.enabled && signal.hasPendingWork);
}

/** Structural subset of Electron's `WebContents` this toggle touches. */
export interface ThrottleableWebContents {
  isDestroyed(): boolean;
  setBackgroundThrottling(allowed: boolean): void;
}

/**
 * Apply the throttling policy to one window's webContents.
 *
 * The `isDestroyed()` guard handles the shutdown race: the signal crosses the
 * renderer→main IPC seam and can arrive between a window's `closed` event and
 * the next GC pass, and calling into a destroyed webContents throws.
 */
export function applyBackgroundThrottle(
  webContents: ThrottleableWebContents,
  signal: BackgroundThrottleSignal,
): void {
  if (webContents.isDestroyed()) return;
  webContents.setBackgroundThrottling(computeBackgroundThrottlingAllowed(signal));
}
