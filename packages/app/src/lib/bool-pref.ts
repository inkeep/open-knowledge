/**
 * Machine-local yes/no view preferences, stored in `localStorage`.
 *
 * `defaultValue` is what an ABSENT key means, and storage holds only the
 * DEVIATION from it: a default-on preference persists `'false'`, a default-off
 * one persists `'true'`, and returning to the default clears the key. That keeps
 * cleared storage equal to intended defaults instead of silently flipping every
 * default-on preference off.
 *
 * SCOPE: this helper owns the `'true'`/`'false'` encoding, which is what most of
 * the app's boolean prefs already use. A minority of older prefs encode `'1'`/`'0'`
 * with always-store semantics instead (`acp/follow-file.ts`,
 * `lib/terminal-new-tab-store.ts`, and others). That split predates this helper and
 * is deliberate to leave alone: adopting it for a `'1'`/`'0'` pref would misread
 * every already-stored value, so migrating one needs a read-both-write-new shim
 * per key, not a call-site swap. Prefer this helper for NEW boolean prefs rather
 * than adding a third encoding.
 *
 * Browser storage is a trust boundary — it throws on quota exhaustion and in
 * some private-browsing modes, and is absent entirely in non-browser contexts.
 * Both helpers swallow those failures: a preference that cannot persist degrades
 * to in-memory for the session rather than breaking the surface that reads it.
 */
export function loadBoolPref(key: string, defaultValue = false): boolean {
  if (typeof window === 'undefined') return defaultValue;
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === null) return defaultValue;
    return stored === 'true';
  } catch {
    return defaultValue;
  }
}

export function saveBoolPref(key: string, value: boolean, defaultValue = false): void {
  if (typeof window === 'undefined') return;
  try {
    if (value === defaultValue) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, value ? 'true' : 'false');
    }
  } catch {
    // quota exceeded / private mode — ignore, stays in-memory
  }
}
