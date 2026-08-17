/**
 * Session-scoped latch that suppresses the persisted-tab-session restore for the
 * single mount that follows a REPEAT app-shell crash.
 *
 * Why this exists: the app-shell error fallback's "Try again" remounts the app,
 * which re-runs the tab-session restore and reopens the very document that
 * crashed — so the same crash fires again and the button can never recover.
 * Recording repeat trips here, and skipping the restore on the second trip, lets
 * the app come back without the crashing tab.
 *
 * Lifetime is the crux and easy to get wrong. The latch lives at MODULE scope so
 * it survives the remount a "Try again" reset triggers (the module stays loaded)
 * but not a page reload or a fresh app launch (a new process re-evaluates the
 * module). React state would reset on the remount — too eager, it would never
 * fire. localStorage or sessionStorage would outlive the reload — too durable, it
 * would suppress restore permanently. A plain in-memory latch is the only store
 * with the lifetime this recovery needs.
 *
 * The recovery has TWO consumers with independent timing: the tab-session
 * restore paths (a render-time initializer on web, an async effect behind the
 * collab gate on desktop) and the mount-time hash navigation (the active tab is
 * mirrored into the URL hash — a third restore vector into the crashing
 * document). Each consumer owns its own one-shot latch, armed together on the
 * repeat trip; with a single shared latch, whichever consumer ran first would
 * disarm the other and leave it to reopen the crashing document.
 */

let lastCrashKey: string | null = null;
let suppressNextRestore = false;
let suppressNextHashNavigation = false;

function crashKey(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/**
 * Record one app-shell crash trip. A second trip carrying the same key as the
 * previous one is the repeat that "Try again" cannot escape on its own, so it
 * arms restore suppression for the next mount. A different key starts a fresh
 * count instead of arming, so an unrelated one-off crash never drops the tab.
 */
export function recordAppShellCrashTrip(error: unknown): void {
  const key = crashKey(error);
  if (key === lastCrashKey) {
    suppressNextRestore = true;
    suppressNextHashNavigation = true;
    return;
  }
  // A different key starts a fresh count. Disarm any suppression the previous
  // error armed: a new, single crash is not a repeat, so it must trip twice on
  // its own before it earns suppression.
  lastCrashKey = key;
  suppressNextRestore = false;
  suppressNextHashNavigation = false;
}

/** Whether the pending mount should skip restoring the persisted tab session. */
export function shouldSuppressTabSessionRestore(): boolean {
  return suppressNextRestore;
}

/**
 * Clear the armed latch and the crash-key memory. The restore path calls this
 * once it has honored a suppression, so the next mount or a reload restores
 * normally and suppression never becomes permanent. Deliberately leaves the
 * hash-navigation latch alone: the restore path resets on its own schedule,
 * which may be before OR after the navigation handler's mount effect, and the
 * navigation side must still observe its armed latch either way.
 */
export function resetTabSessionRestoreSuppression(): void {
  suppressNextRestore = false;
  lastCrashKey = null;
}

/**
 * One-shot check-and-clear for the navigation side of the same recovery. The
 * hash handler consumes this on its first mount after the repeat crash and
 * drops the stale hash instead of navigating it, so the guard covers exactly
 * one mount and ordinary hash navigation resumes immediately after. Owns its
 * own latch rather than reading the restore latch above because the two
 * consumers observe the armed state at different times (render-time on web,
 * behind an async gate on desktop) — reading a shared latch here would return
 * false whenever the restore path consumed first.
 */
export function consumeHashNavigationSuppression(): boolean {
  const armed = suppressNextHashNavigation;
  suppressNextHashNavigation = false;
  return armed;
}
