import { renderThemeBlock } from '@inkeep/open-knowledge-core';
import { useEffect } from 'react';
import {
  base16ToTokens,
  buildCustomThemeCss,
  COLOR_THEMES,
  type ColorTheme,
  type ColorThemeSelection,
  colorThemeMode,
  customThemeKind,
  resolveColorTheme,
  resolveCustomScheme,
} from './color-themes';
import { narrowThemePreference } from './use-apply-config-theme';

/**
 * localStorage key the FOUC script in `index.html` reads pre-paint: the light +
 * dark palette pair, each already resolved to the `dark`-class state it applies,
 * plus the mode preference that chooses between them. Keep both in sync.
 *
 * Named `...-pair-...` rather than a plural of the legacy `ok-color-theme-v1`:
 * the pre-paint script reads both keys a few statements apart, and a
 * one-character difference between two caches of different shapes is a
 * footgun.
 *
 * The pair carries its own copy of the mode preference rather than reusing
 * next-themes' `ok-theme-v1`: a palette forces its own variant, so `setTheme`
 * can leave `dark` in that key while the user's preference is still `system`.
 * Reading it to pick a slot would then lock the app to one slot after the first
 * cross-variant pick.
 */
export const COLOR_THEME_PAIR_STORAGE_KEY = 'ok-color-theme-pair-v1';

/** The single-palette FOUC cache written before the light/dark pair existed. */
export const COLOR_THEME_STORAGE_KEY = 'ok-color-theme-v1';

/** Shared single-palette CSS cache written by older builds. Removed after the pair cache is written. */
export const CUSTOM_THEME_STORAGE_KEY = 'ok-custom-theme-v1';

/** The `<html>` attribute the generated `color-themes.generated.css` rules key off. */
export const COLOR_THEME_ATTRIBUTE = 'data-color-theme';

/** id of the runtime `<style>` element holding the active custom palette. */
export const CUSTOM_THEME_STYLE_ID = 'ok-custom-theme';

/** id of the runtime `<style>` element holding the active saved palette. */
export const SAVED_THEME_STYLE_ID = 'ok-saved-theme';

type SeedInput = Record<string, unknown> | undefined;

/** One slot of the FOUC cache, including prebuilt CSS when the palette is runtime-authored. */
interface CachedSlot {
  id: string;
  dark: boolean;
  css?: string;
}

export interface ApplyColorThemeInput {
  /** The light + dark palette pair from merged config. */
  selection: ColorThemeSelection;
  /** The user's `appearance.theme` preference. */
  modePreference: 'light' | 'dark' | 'system' | undefined;
  /** Which slot that preference resolves to right now (the OS decides for `'system'`). */
  slotMode: 'light' | 'dark';
  /** The user's custom-theme scheme (partial); only consulted for the `custom` palette. */
  customSeed?: SeedInput;
  /** Built-in and saved palettes available to resolve the selected ids. */
  themes?: readonly ColorTheme[];
  /** The Themes plugin toggle. Off applies exactly like `default`. */
  enabled?: boolean;
  /**
   * Whether startup config and any selected saved-theme registry entries are
   * authoritative. While false, the hook leaves the prepaint DOM untouched so
   * hydration cannot flash the default palette between cache replay and sync.
   * Direct imperative calls are ready by definition.
   */
  ready?: boolean;
}

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

function savedThemeCss(theme: ColorTheme): string | undefined {
  if (!theme.scheme) return undefined;
  return renderThemeBlock(
    `html[${COLOR_THEME_ATTRIBUTE}]`,
    theme.scheme.variant,
    base16ToTokens(theme.scheme),
  );
}

function upsertSavedThemeStyle(css: string): void {
  let style = document.getElementById(SAVED_THEME_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = SAVED_THEME_STYLE_ID;
    document.head.appendChild(style);
  }
  if (style.textContent !== css) style.textContent = css;
}

function removeSavedThemeStyle(): void {
  document.getElementById(SAVED_THEME_STYLE_ID)?.remove();
}

/**
 * The `dark`-class state a palette produces in a given slot. A palette carries
 * its own variant and keeps forcing it — a dark scheme picked as the light-mode
 * palette still paints dark, so Tailwind `dark:` variants resolve against the
 * tokens actually on screen. Only a palette-less `default` defers to the slot.
 */
function slotIsDark(
  id: string,
  slot: 'light' | 'dark',
  customSeed: SeedInput,
  themes: readonly ColorTheme[],
): boolean {
  if (id === 'custom') return customThemeKind(resolveCustomScheme(customSeed)) === 'dark';
  return (colorThemeMode(id, themes) ?? slot) === 'dark';
}

function slotCss(
  id: string,
  customSeed: SeedInput,
  themes: readonly ColorTheme[],
): string | undefined {
  if (id === 'custom') return buildCustomThemeCss(resolveCustomScheme(customSeed));
  if (COLOR_THEMES.some((theme) => theme.id === id)) return undefined;
  const theme = themes.find((candidate) => candidate.id === id);
  return theme ? savedThemeCss(theme) : undefined;
}

function cachedSlot(
  id: string,
  slot: 'light' | 'dark',
  customSeed: SeedInput,
  themes: readonly ColorTheme[],
): CachedSlot {
  const dark = slotIsDark(id, slot, customSeed, themes);
  const css = slotCss(id, customSeed, themes);
  return css ? { id, dark, css } : { id, dark };
}

/** Which palette applies right now, and whether it paints dark. */
function activeColorTheme(input: ApplyColorThemeInput): CachedSlot {
  const { selection, slotMode, customSeed, themes = COLOR_THEMES, enabled = true } = input;
  const id = resolveColorTheme(enabled ? selection[slotMode] : 'default', themes).id;
  return { id, dark: slotIsDark(id, slotMode, customSeed, themes) };
}

/**
 * Apply the mode-selected color theme to the DOM now: set (or clear, for
 * `default`) the `data-color-theme` attribute on `<html>`, inject/remove the
 * runtime palette `<style>`, and mirror the whole pair into the localStorage
 * cache the pre-paint FOUC script reads on the next reload.
 * Idempotent. Shared by the config effect below and the Settings picker's
 * optimistic on-click apply so both paths stay byte-identical.
 *
 * The cache holds BOTH slots, not just the active one, because the OS
 * appearance can change while the app is closed — the pre-paint script has to
 * be able to pick the other slot without loading a bundle.
 *
 * `enabled: false` (the Themes plugin toggled off) applies exactly like
 * `default`: the attribute clears, no custom `<style>` is injected, and every
 * FOUC cache is removed — the mirror is how pre-paint learns the disabled
 * state, so a reload can't flash the palette back.
 */
export function applyColorThemeToDom(input: ApplyColorThemeInput): void {
  if (typeof document === 'undefined') return;
  const { selection, modePreference, customSeed, themes = COLOR_THEMES, enabled = true } = input;
  const active = activeColorTheme(input);
  const activeTheme = resolveColorTheme(active.id, themes);
  const root = document.documentElement;

  if (active.id === 'default') {
    root.removeAttribute(COLOR_THEME_ATTRIBUTE);
  } else {
    root.setAttribute(COLOR_THEME_ATTRIBUTE, active.id);
  }

  const activeSavedCss =
    !COLOR_THEMES.some((theme) => theme.id === active.id) && activeTheme.id === active.id
      ? savedThemeCss(activeTheme)
      : undefined;
  if (activeSavedCss) upsertSavedThemeStyle(activeSavedCss);
  else removeSavedThemeStyle();

  if (active.id === 'custom') {
    upsertCustomStyle(buildCustomThemeCss(resolveCustomScheme(customSeed)));
  } else removeCustomStyle();

  const bothDefault = selection.light === 'default' && selection.dark === 'default';
  try {
    if (!enabled || bothDefault) {
      localStorage.removeItem(COLOR_THEME_PAIR_STORAGE_KEY);
    } else {
      localStorage.setItem(
        COLOR_THEME_PAIR_STORAGE_KEY,
        JSON.stringify({
          pref: narrowThemePreference(modePreference),
          light: cachedSlot(selection.light, 'light', customSeed, themes),
          dark: cachedSlot(selection.dark, 'dark', customSeed, themes),
        }),
      );
    }
    // The pre-paint script falls back to the single-palette key only when the
    // pair is absent, so a stale one left by an older build would shadow a
    // deliberate reset back to `default`.
    localStorage.removeItem(COLOR_THEME_STORAGE_KEY);
    localStorage.removeItem(CUSTOM_THEME_STORAGE_KEY);
  } catch {
    // Private-mode / storage-disabled: the attribute + style are still applied
    // for this session; only the next-reload FOUC pre-paint is forgone.
  }
}

/**
 * Bridge the merged-config color-theme pair (+ the `appearance.customTheme`
 * scheme) into the DOM app-wide.
 *
 * `slotMode` is what makes the pair live: it tracks `appearance.theme`, and for
 * `'system'` the OS preference, so an OS appearance change swaps the palette
 * without a config write. The `.dark` class itself is handled separately by
 * `useApplyConfigTheme` (next-themes owns it) — this hook only toggles which
 * palette overlay is active. `default` (and any unknown value) clears the
 * attribute so the base `:root` / `.dark` theme shows through.
 *
 * Unlike the mode flip there is no cross-window storm risk here: nothing
 * listens for the color-theme `storage` events, so a write doesn't re-enter
 * this effect in other windows.
 */
export function useApplyConfigColorTheme(input: ApplyColorThemeInput): void {
  const {
    selection,
    modePreference,
    slotMode,
    customSeed,
    themes,
    enabled = true,
    ready = true,
  } = input;
  // Serialize the scheme so the effect re-runs on a live color edit while the
  // custom theme is in play, without depending on object identity. `seedKey` is
  // the value-stable proxy for `customSeed`; depending on the object directly
  // would churn on every render, and biome can't see the proxy relationship.
  const seedKey =
    enabled && (selection.light === 'custom' || selection.dark === 'custom')
      ? JSON.stringify(customSeed ?? null)
      : '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: seedKey is the value-stable proxy for customSeed (see above).
  useEffect(() => {
    if (!ready) return;
    applyColorThemeToDom({ selection, modePreference, slotMode, customSeed, themes, enabled });
  }, [selection.light, selection.dark, modePreference, slotMode, seedKey, themes, enabled, ready]);
}
