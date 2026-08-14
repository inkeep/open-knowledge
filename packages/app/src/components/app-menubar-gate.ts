/**
 * Eager-bundle gate for the Windows/Linux custom menubar. Split from
 * `AppMenubar.tsx` so the mount sites (EditorHeader, NavigatorApp) can
 * decide WHETHER to render without pulling the menubar component — and its
 * radix Menubar primitive — into the eager bundle: `AppMenubar` is
 * lazy-loaded, and on web, macOS, and focused note windows (where this
 * predicate is false) its chunk never downloads at all.
 */
export function shouldShowAppMenubar(): boolean {
  if (typeof window === 'undefined') return false;
  const bridge = window.okDesktop;
  return (
    bridge != null &&
    bridge.menu != null &&
    bridge.platform !== 'darwin' &&
    bridge.config?.mode !== 'note'
  );
}
