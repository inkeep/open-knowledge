import { isSafeNavigationUrl } from '@/editor/safe-navigation-url';

/**
 * In Electron, `<a target="_blank">` opens the URL in an in-app
 * BrowserWindow. Wire this onto BOTH `onClick` and `onAuxClick` so
 * left-click and middle-/cmd-click route through the OS default browser
 * when the desktop bridge is present, falling through to the anchor's
 * default behavior on web.
 */
export function dispatchExternalLinkClick(e: { preventDefault: () => void }, url: string): void {
  const openExternal = window.okDesktop?.shell?.openExternal;
  if (!openExternal) return;
  e.preventDefault();
  // Same catch discipline as openExternalUrl: the bridge rejects schemes
  // outside the main-process allowlist; swallow + warn so a rejected open
  // can't surface as an unhandled rejection.
  void openExternal(url).catch((err: unknown) => {
    console.warn('[external-link] openExternal failed', url, err);
  });
}

/**
 * Optional overrides for tests. Production callers pass nothing and get the
 * real `window.okDesktop` bridge + the real `window.open`. Mirrors the
 * injection convention of `dispatchAssetClick` / handoff `openExternal`,
 * since plain `.test.ts` runs without a DOM `window`.
 */
interface OpenExternalUrlDeps {
  /** Electron preload bridge. Absent on web / CLI. Defaults to `window.okDesktop`. */
  readonly okDesktop?: { shell?: { openExternal?: (url: string) => Promise<void> } };
  /** Web new-tab opener. Defaults to `window.open`. */
  readonly openWindow?: (url: string, target: string, features: string) => unknown;
}

/**
 * Imperative external-URL open for call sites that have no anchor event to
 * `preventDefault` — graph-view nodes, "Open link" buttons, etc. On the
 * Electron desktop the renderer MUST route through
 * `window.okDesktop.shell.openExternal` so the URL lands in the OS default
 * browser: a raw `window.open` is turned into a new in-app BrowserWindow
 * (the main-process new-window safety net is not a reliable substitute, and
 * relying on it left external graph links opening inside Open Knowledge).
 * On web there's no bridge, so it falls through to the original
 * `window.open(url, '_blank', 'noopener,noreferrer')` new-tab behavior.
 */
export function openExternalUrl(url: string, deps: OpenExternalUrlDeps = {}): void {
  // Structural security gate (defense-in-depth): refuse `javascript:`/`data:`/
  // `vbscript:` etc. here so no caller can route an unsafe scheme to
  // `window.open` (web fallback) by forgetting the check. Callers that need
  // the boolean to drive control flow (e.g. a link chip that falls through to
  // its edit panel) still call `isSafeNavigationUrl` themselves; this makes the
  // invariant hold regardless. Relative `#/…` hash routes are not external and
  // never reach here.
  if (!isSafeNavigationUrl(url)) {
    console.warn('[external-link] blocked non-safe scheme', url);
    return;
  }
  const globalBridge = typeof window !== 'undefined' ? window.okDesktop : undefined;
  const okDesktop = 'okDesktop' in deps ? deps.okDesktop : globalBridge;
  const openExternal = okDesktop?.shell?.openExternal;
  if (openExternal) {
    // Fire-and-forget, but catch: the desktop bridge REJECTS schemes outside
    // the main-process outbound allowlist (e.g. an authored `tel:` link passes
    // the renderer's isSafeNavigationUrl gate but is not in ALLOWED_SCHEMES).
    // Swallow + warn so a rejected open can't surface as an unhandled rejection.
    void openExternal(url).catch((err: unknown) => {
      console.warn('[external-link] openExternal failed', url, err);
    });
    return;
  }
  const globalOpen = typeof window !== 'undefined' ? window.open.bind(window) : undefined;
  const openWindow = deps.openWindow ?? globalOpen;
  openWindow?.(url, '_blank', 'noopener,noreferrer');
}
