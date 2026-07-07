/**
 * URL-scheme allowlist for any code path that hands an authored URL to
 * `window.open` / `window.location.assign` / `<a href>` without an anchor
 * intermediary.
 *
 * `isExternalHref(href)` (in
 * `packages/core/src/utils/link-targets.ts`) matches ANY scheme prefix —
 * including `javascript:`, `data:`, `vbscript:`, `blob:`. In a multi-user
 * collab / MCP-agent-writes / external-disk-write threat model, an authored
 * `[click](javascript:...)` reaches `window.open` unfiltered, executing
 * arbitrary JS in the viewer's origin. React's sanitizeURL only runs on
 * DOM-attribute writes — it does NOT protect `window.open`.
 *
 * This helper returns true only when the URL's scheme is in a tight
 * navigation-safe allowlist. Consumers MUST call this before any imperative
 * navigation path fires; failure to classify falls back to NO navigation.
 *
 * Non-goals:
 *   - Does not validate the path portion of the URL (no CSRF concerns).
 *   - Does not sanitize HTML or attributes.
 *   - Does not replace CSP or SameSite cookie protections.
 */

/**
 * Allowed navigation schemes. `http:` and `https:` cover the vast majority
 * of authored external links. `mailto:` and `tel:` are safe because the OS
 * handles them, not the renderer — no JS execution in the viewer's origin.
 */
const NAVIGATION_ALLOWED_SCHEMES: ReadonlySet<string> = new Set([
  'http:',
  'https:',
  'mailto:',
  'tel:',
]);

/**
 * Returns true when `url` has a scheme we are willing to navigate to. Any
 * other scheme — including `javascript:`, `data:`, `vbscript:`, `blob:`,
 * `file:`, `ws:`, etc. — returns false.
 *
 * Parse-failure (non-URL strings) also returns false — protocol can't be
 * determined, so we refuse to navigate. Callers that want to navigate to
 * relative/app-internal targets should use the dedicated internal-hash
 * helpers instead of passing the raw string through here.
 */
export function isSafeNavigationUrl(url: string): boolean {
  try {
    // URL parser needs a base to resolve relative URLs. We don't care about
    // relative URLs here — we're deciding "is this safe to pass to
    // window.open" — so we pass an arbitrary dummy base and check whether
    // parsing resolves to an absolute target-scheme URL, not a relative one
    // against the base.
    const parsed = new URL(url);
    return NAVIGATION_ALLOWED_SCHEMES.has(parsed.protocol);
  } catch {
    return false;
  }
}
