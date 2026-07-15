import { useEffect } from 'react';
import {
  buildCustomThemeCss,
  type CustomThemeSeed,
  customThemeKind,
  resolveColorTheme,
  resolveCustomSeed,
} from './color-themes';

/** localStorage key the FOUC script in `index.html` reads pre-paint. Keep both in sync. */
export const COLOR_THEME_STORAGE_KEY = 'ok-color-theme-v1';

/** localStorage key holding the active custom theme's prebuilt CSS + kind, for flash-free reload. */
export const CUSTOM_THEME_STORAGE_KEY = 'ok-custom-theme-v1';

/** The `<html>` attribute the generated `color-themes.generated.css` rules key off. */
export const COLOR_THEME_ATTRIBUTE = 'data-color-theme';

/** id of the runtime `<style>` element holding the active custom palette. */
export const CUSTOM_THEME_STYLE_ID = 'ok-custom-theme';

type SeedInput = Partial<Record<keyof CustomThemeSeed, unknown>> | undefined;

function upsertCustomStyle(css: string): void {
  let style = document.getElementById(CUSTOM_THEME_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = CUSTOM_THEME_STYLE_ID;
    document.head.appendChild(style);
  }
  if (style.textContent !== css) style.textContent = css;
}

function removeCustomStyle(): void {
  document.getElementById(CUSTOM_THEME_STYLE_ID)?.remove();
}

/**
 * Apply a color theme to the DOM now: set (or clear, for `default`) the
 * `data-color-theme` attribute on `<html>`, inject/remove the runtime custom
 * palette `<style>`, and mirror everything into the localStorage caches the
 * pre-paint FOUC script reads on the next reload. Idempotent. Shared by the
 * config effect below and the Settings picker's optimistic on-click apply so
 * both paths stay byte-identical.
 *
 * `customSeed` is only consulted for the `custom` theme; pass the merged-config
 * `appearance.customTheme` (a partial seed — missing/invalid fields fall back
 * to the default palette).
 *
 * `enabled: false` (the Themes plugin toggled off) applies exactly like
 * `default`: the attribute clears, no custom `<style>` is injected, and BOTH
 * FOUC caches are removed — the mirror is how pre-paint learns the disabled
 * state, so a reload can't flash the palette back.
 */
export function applyColorThemeToDom(
  colorThemeValue: string | undefined,
  customSeed?: SeedInput,
  enabled = true,
): void {
  if (typeof document === 'undefined') return;
  const theme = resolveColorTheme(enabled ? colorThemeValue : 'default');
  const root = document.documentElement;

  if (theme.id === 'default') {
    root.removeAttribute(COLOR_THEME_ATTRIBUTE);
  } else {
    root.setAttribute(COLOR_THEME_ATTRIBUTE, theme.id);
  }

  let customCacheEntry: string | null = null;
  if (theme.id === 'custom') {
    const seed = resolveCustomSeed(customSeed);
    const css = buildCustomThemeCss(seed);
    upsertCustomStyle(css);
    customCacheEntry = JSON.stringify({ css, dark: customThemeKind(seed) === 'dark' });
  } else {
    removeCustomStyle();
  }

  try {
    if (theme.id === 'default') {
      localStorage.removeItem(COLOR_THEME_STORAGE_KEY);
    } else {
      localStorage.setItem(COLOR_THEME_STORAGE_KEY, theme.id);
    }
    if (customCacheEntry) {
      localStorage.setItem(CUSTOM_THEME_STORAGE_KEY, customCacheEntry);
    } else {
      localStorage.removeItem(CUSTOM_THEME_STORAGE_KEY);
    }
  } catch {
    // Private-mode / storage-disabled: the attribute + style are still applied
    // for this session; only the next-reload FOUC pre-paint is forgone.
  }
}

/**
 * Bridge the merged-config `appearance.colorTheme` (+ `appearance.customTheme`
 * seed) into the DOM app-wide.
 *
 * The dark/light *mode* that a palette forces is handled separately by
 * `useApplyConfigTheme` (next-themes owns the `.dark` class) — this hook only
 * toggles which palette overlay is active. `default` (and any unknown value)
 * clears the attribute so the base `:root` / `.dark` theme shows through.
 *
 * Unlike the mode flip there is no cross-window storm risk here: nothing
 * listens for the `ok-color-theme-v1` `storage` event, so a write doesn't
 * re-enter this effect in other windows.
 */
export function useApplyConfigColorTheme(
  colorThemeValue: string | undefined,
  customSeed?: SeedInput,
  enabled = true,
): void {
  // Serialize the seed so the effect re-runs on a live color edit while the
  // custom theme is active, without depending on object identity. `seedKey` is
  // the value-stable proxy for `customSeed`; depending on the object directly
  // would churn on every render, and biome can't see the proxy relationship.
  const seedKey = enabled && colorThemeValue === 'custom' ? JSON.stringify(customSeed ?? null) : '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: seedKey is the value-stable proxy for customSeed (see above).
  useEffect(() => {
    applyColorThemeToDom(colorThemeValue, customSeed, enabled);
  }, [colorThemeValue, seedKey, enabled]);
}
