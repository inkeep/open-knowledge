import { useTheme } from 'next-themes';
import { useEffect } from 'react';

/** The three values `appearance.theme` accepts; `system` tracks the OS. */
export type ThemePreference = 'system' | 'light' | 'dark';

/**
 * Narrow an unknown stored value to a pickable preference.
 *
 * Anything that is not an explicit 'dark' or 'light' — an unset
 * `appearance.theme`, next-themes' literal 'system', a hand-edited config
 * carrying nonsense — resolves to 'system', which is what the app actually does
 * in each of those cases. Callers must NOT substitute the resolved mode here:
 * 'system' is the OS-tracking lever, and collapsing it to 'dark'/'light' checks
 * the wrong card and strands the user's choice to follow the OS.
 *
 * Lives beside the apply hook rather than beside the picker so the non-React
 * `lib/` callers can reach it without importing a component, which is where
 * `narrowLanguagePreference` sits for the same reason.
 */
export function narrowThemePreference(value: unknown): ThemePreference {
  return value === 'dark' || value === 'light' ? value : 'system';
}

/**
 * Apply the merged-config `appearance.theme` into next-themes, app-wide. Owned
 * by `ConfigProvider`; the single seam that turns a config value (Settings
 * pane, an external file edit picked up by the chokidar watcher, or another
 * window's change) into the `next-themes` `dark`/`light` class flip.
 *
 * `setTheme` writes through to the `ok-theme-v1` localStorage FOUC cache, so the
 * pre-paint script reads the latest value on next reload.
 *
 * STORM GUARD — the dependency array is `[themeValue]` ONLY; `setTheme` is
 * deliberately excluded. next-themes' `setTheme` is memoized on the currently
 * stored theme (`useCallback([storedTheme])` in 0.4.6 — the stored theme
 * *state*, NOT the `themeValue` we pass in), so its identity changes on every
 * theme-state change AND every call writes `localStorage`. All OK windows share
 * one `localStorage` (BrowserWindows have
 * no session partition), and next-themes listens for cross-window `storage`
 * events. If `setTheme` were a dependency, then on a NON-primary window:
 *
 *   1. another window's (optimistic) flip writes `localStorage` → fires a
 *      `storage` event here → next-themes sets its state to the new value;
 *   2. that state change churns `setTheme`'s identity → this effect re-fires →
 *      it re-applies the STALE merged `themeValue` (this window's config
 *      round-trip lands ~300ms later via the file watcher);
 *   3. re-applying the stale value WRITES it back to the shared `localStorage`
 *      → which re-broadcasts a `storage` event to every other window → which
 *      revert and re-broadcast in turn.
 *
 * The result is the multi-window light/dark flicker storm that only settles
 * once every window's config round-trip converges. Depending on `[themeValue]`
 * alone breaks the loop: the effect still re-captures the current `setTheme`
 * whenever `themeValue` actually changes, so the excluded dep is never stale at
 * call time, and a churn-only re-fire (the storm trigger) no longer happens.
 *
 * Verified against next-themes 0.4.6 source — an observed implementation detail,
 * not a public contract. Re-evaluate this `setTheme` exclusion when upgrading
 * past 0.4.x: 1.0 changes `setTheme` to `useCallback([forcedTheme])`, which
 * removes the identity churn and would make the exclusion unnecessary.
 */
export function useApplyConfigTheme(themeValue: string | undefined): void {
  const { setTheme } = useTheme();
  // biome-ignore lint/correctness/useExhaustiveDependencies: setTheme excluded by design — re-adding it re-fires on every cross-window theme flip and storms every window (see STORM GUARD above).
  useEffect(() => {
    if (themeValue === 'light' || themeValue === 'dark' || themeValue === 'system') {
      setTheme(themeValue);
    }
  }, [themeValue]);
}
