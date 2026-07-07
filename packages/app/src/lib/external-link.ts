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
  void openExternal(url);
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
  const globalBridge = typeof window !== 'undefined' ? window.okDesktop : undefined;
  const okDesktop = 'okDesktop' in deps ? deps.okDesktop : globalBridge;
  const openExternal = okDesktop?.shell?.openExternal;
  if (openExternal) {
    void openExternal(url);
    return;
  }
  const globalOpen = typeof window !== 'undefined' ? window.open.bind(window) : undefined;
  const openWindow = deps.openWindow ?? globalOpen;
  openWindow?.(url, '_blank', 'noopener,noreferrer');
}
