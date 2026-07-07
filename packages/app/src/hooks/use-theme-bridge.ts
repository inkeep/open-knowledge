import { useEffect } from 'react';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

/**
 * Push the user-intent theme value to Electron main's
 * `nativeTheme.themeSource` and signal cold-launch + reduced-transparency
 * state to the show-gate. Single source of truth for the renderer→main
 * theme-bridge wiring shared by `ConfigProvider` (CRDT-backed editor flow)
 * and `NavigatorApp` (next-themes-backed launcher flow).
 *
 * The hook owns three concerns:
 *
 *   1. setThemeSource on every cold-launch / theme change. The user-intent
 *      string is forwarded verbatim — `'system'` is the lever for OS
 *      auto-tracking; resolving it here (matchMedia / ternary) would freeze
 *      chrome to one theme even when the user later flips macOS appearance.
 *
 *   2. signalThemeApplied in `.finally(...)` so the cold-launch show-gate
 *      releases on both success and failure paths. If the IPC roundtrip
 *      rejects (channel teardown race, bootstrap ordering regression,
 *      future bridge-contract divergence), the gate would otherwise stall
 *      blank for the full 5 s safety timeout. A transient frame of
 *      mismatched chrome is strictly preferable to no window at all; the
 *      structured warn in `.catch(...)` keeps the failure observable.
 *
 *   3. Mid-session `prefers-reduced-transparency` toggles. When the user
 *      flips System Settings → Accessibility → Display → Reduce
 *      transparency, push the new value to main so vibrancy material is
 *      enabled / disabled live without an app restart.
 *
 * Web / CLI distribution: the bridge is undefined and every effect
 * early-returns. The initial cold-launch reading of
 * `prefers-reduced-transparency` is sampled at signal time so chrome
 * reflects the OS preference from frame 1.
 */
export function useThemeBridge(
  bridge: OkDesktopBridge | undefined,
  themeValue: string | undefined,
): void {
  useEffect(() => {
    if (themeValue !== 'light' && themeValue !== 'dark' && themeValue !== 'system') return;
    if (!bridge) return;
    let cancelled = false;
    bridge
      .setThemeSource(themeValue)
      .catch((err: unknown) => {
        console.warn(
          JSON.stringify({
            event: 'theme-source-set-failed',
            themeValue,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      })
      .finally(() => {
        if (cancelled) return;
        const reducedTransparency = window.matchMedia(
          '(prefers-reduced-transparency: reduce)',
        ).matches;
        bridge.signalThemeApplied({ reducedTransparency });
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, themeValue]);

  useEffect(() => {
    if (!bridge) return;
    const mql = window.matchMedia('(prefers-reduced-transparency: reduce)');
    const handler = (event: MediaQueryListEvent) => {
      bridge.signalThemeApplied({ reducedTransparency: event.matches });
    };
    mql.addEventListener('change', handler);
    return () => {
      mql.removeEventListener('change', handler);
    };
  }, [bridge]);
}
