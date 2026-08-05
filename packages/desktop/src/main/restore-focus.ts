/**
 * Focus posture for the clean-exit window-restore snapshot — how the restored
 * windows reveal, and whether the raise that follows takes foreground.
 *
 * A multi-window restore reopens every project that was open, each in its own
 * window. Each window's OS-level reveal is deferred behind its own dual-signal
 * show gate (see `show-gate.ts`), and those gates release in nondeterministic
 * order — every reveal lands above its predecessors in the window stack, so
 * whichever one releases LAST would end up frontmost. That is rarely the window
 * the user was working in.
 *
 * The restore snapshot is ordered least → most recently focused (see
 * `sortByFocusSequence`), so its last entry is the window to land in. Raising
 * that window as soon as the open promises settle is not enough: those promises
 * resolve after `loadURL`, well before the deferred reveals, so a sibling
 * revealing later would bury the target again. This module waits until EVERY
 * restored window has revealed, then raises the target so it is the last one to
 * win. Waiting for all reveals also guarantees the target is already shown
 * before the raise, so `bringToFront` never bypasses its own gate.
 *
 * Electron-free by construction: `RevealableWindow` is a structural subset and
 * timers are injected, so tests exercise the ordering without a real
 * BrowserWindow.
 */

/**
 * Whether a window revealing at this instant should appear without pulling the
 * app to the foreground. Canonical statement of the three-term rule; the
 * show gate's `shouldRevealInactive` predicate is this function.
 *
 * `restoreInProgress` scopes the whole rule to a restore. A restore of N
 * projects reveals N windows over several seconds (each waits on its own server
 * to bind), and on macOS a plain `show()` activates the app — so unscoped, each
 * reveal drags a user who switched away while waiting back out of whatever they
 * moved to.
 *
 * `appHasEverBeenActive` is what keeps the rule from suppressing itself. macOS
 * reports activation only as a consequence of something taking focus, so a
 * launch whose windows all reveal via `showInactive()` never becomes active:
 * `appIsActive` would sit false for the whole run, unable to tell "the user
 * walked away" from "we were never in front to begin with". Requiring a prior
 * activation lets the FIRST restored window reveal normally, which costs the one
 * activation a user who asked for a relaunch expects anyway and makes departure
 * observable for every window after it. Dropping this term reads like a
 * simplification and is a worse bug — the app would never come forward at all,
 * so a user who waited gets their session back silently behind another app.
 *
 * `appIsActive` then silences every remaining reveal the moment the user does
 * move elsewhere.
 */
export function shouldRevealInactiveNow(state: {
  /** A boot restore is opening its window set and has not yet made its raise. */
  restoreInProgress: boolean;
  /** The app has been frontmost at least once this run. */
  appHasEverBeenActive: boolean;
  /** The app is frontmost right now. */
  appIsActive: boolean;
}): boolean {
  return state.restoreInProgress && state.appHasEverBeenActive && !state.appIsActive;
}

/** Structural subset of BrowserWindow used to observe reveal state. */
export interface RevealableWindow {
  isDestroyed?(): boolean;
  isVisible?(): boolean;
  /**
   * Fires when the window is shown. Electron emits `show` for BOTH `show()` and
   * `showInactive()` (macOS raises it off the window's occlusion-state change),
   * so a quietly-revealed window still settles this wait rather than stalling it
   * until the safety timeout.
   */
  once(event: 'show', listener: () => void): void;
}

export interface RestoreFocusDeps {
  /** Production wires `(cb, ms) => setTimeout(cb, ms)`; tests inject a captured-timer mock. */
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  /**
   * Safety bound so a window whose `show()` never emits `show` (a pathological
   * native failure) can't stall the raise forever. Must comfortably exceed the
   * show gate's own timeout, since a genuinely gated window emits `show` when
   * that gate force-shows it.
   */
  timeoutMs: number;
}

/**
 * Comfortably above the show gate's 5 s force-show timeout: a window still
 * waiting on its dual-signal gate emits `show` when that gate fires, so this
 * only backstops a `show()` that throws or never dispatches `show`.
 */
export const RESTORE_REVEAL_TIMEOUT_MS = 8_000;

/**
 * Resolve once a window has revealed — it is already visible, it was destroyed
 * (closed mid-restore), it fires `show`, or the safety timeout elapses.
 */
export function whenWindowRevealed(win: RevealableWindow, deps: RestoreFocusDeps): Promise<void> {
  return new Promise<void>((resolve) => {
    if (win.isDestroyed?.() === true || win.isVisible?.() === true) {
      resolve();
      return;
    }
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (handle !== undefined) deps.clearTimeout(handle);
      resolve();
    };
    const handle = deps.setTimeout(finish, deps.timeoutMs);
    win.once('show', finish);
  });
}

/**
 * After a multi-window restore, wait for every restored window to reveal, then
 * raise the most-recently-focused one (the snapshot's last entry) so it wins the
 * final `show()`. Windows that failed to open (fell back to the Navigator) or
 * were destroyed mid-restore are skipped; if the target itself is gone, nothing
 * is raised.
 *
 * Whether that raise also pulls the app to the foreground is decided by
 * `shouldActivate`, called AFTER every reveal has settled. Evaluating it that
 * late is the point: a restore can take many seconds, and the user may well
 * have given up waiting and switched to another app in the meantime. Asking at
 * raise time captures the whole restore window, so the app claims foreground
 * only if the user actually stayed.
 *
 * @param windowKeys Restore keys — a project path OR a loose-file's canonical
 *   file path — ordered least → most recently focused. `getWindow` / `raise`
 *   resolve either kind (the WM lookups canonicalize their input).
 */
export async function raiseMostRecentlyFocusedAfterRestore(input: {
  windowKeys: readonly string[];
  getWindow: (key: string) => RevealableWindow | undefined;
  raise: (key: string, opts: { activate: boolean }) => void;
  /**
   * `true` → the raise may foreground the app; `false` → order the window
   * within the app but leave the user's current app alone. Omitted → always
   * activate, preserving the behavior from before this was configurable.
   */
  shouldActivate?: () => boolean;
  deps: RestoreFocusDeps;
}): Promise<void> {
  const { windowKeys, getWindow, raise, shouldActivate, deps } = input;
  const target = windowKeys[windowKeys.length - 1];
  if (target === undefined) return;

  await Promise.all(
    windowKeys.map((key) => {
      const win = getWindow(key);
      if (!win || win.isDestroyed?.() === true) return Promise.resolve();
      return whenWindowRevealed(win, deps);
    }),
  );

  const targetWin = getWindow(target);
  if (!targetWin || targetWin.isDestroyed?.() === true) return;
  raise(target, { activate: shouldActivate === undefined || shouldActivate() });
}
