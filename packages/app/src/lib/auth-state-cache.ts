/**
 * Cross-surface cache of the last resolved GitHub auth state.
 *
 * Auth-reactive surfaces (the Clone dialog's repo browser, the Settings →
 * Account section) each run their own status check, but a freshly opened
 * surface would otherwise flash its signed-out view for the duration of that
 * check. Seeding the first paint from this shared value avoids the flash, and
 * lets one surface's disconnect repaint the others without a relaunch: it is
 * written by every resolved status check and read by every surface's first
 * render.
 *
 * `null` = not checked yet this session. Each resolved status check overwrites
 * it, so a stale value self-heals on the next on-open re-check.
 *
 * Module-level (one value per renderer process). Concurrent surfaces in the
 * same process share it; a future multi-window launcher mounting two would
 * share and race this write, but the only risk is a brief wrong-paint on one
 * surface — never data loss — and the on-open re-check corrects it.
 */
let lastKnownSignedIn: boolean | null = null;

export function getLastKnownSignedIn(): boolean | null {
  return lastKnownSignedIn;
}

export function setLastKnownSignedIn(value: boolean | null): void {
  lastKnownSignedIn = value;
}
