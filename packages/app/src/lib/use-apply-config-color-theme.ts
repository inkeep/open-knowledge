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

export const COLOR_THEME_PAIR_STORAGE_KEY = 'ok-color-theme-pair-v1';

export const COLOR_THEME_STORAGE_KEY = 'ok-color-theme-v1';

export const CUSTOM_THEME_STORAGE_KEY = 'ok-custom-theme-v1';

export const COLOR_THEME_ATTRIBUTE = 'data-color-theme';

export const CUSTOM_THEME_STYLE_ID = 'ok-custom-theme';

export const SAVED_THEME_STYLE_ID = 'ok-saved-theme';

type SeedInput = Record<string, unknown> | undefined;

interface CachedSlot {
  id: string;
  dark: boolean;
  css?: string;
}

export interface ApplyColorThemeInput {
  selection: ColorThemeSelection;
  modePreference: 'light' | 'dark' | 'system' | undefined;
  slotMode: 'light' | 'dark';
  customSeed?: SeedInput;
  themes?: readonly ColorTheme[];
  enabled?: boolean;
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

function activeColorTheme(input: ApplyColorThemeInput): CachedSlot {
  const { selection, slotMode, customSeed, themes = COLOR_THEMES, enabled = true } = input;
  const id = resolveColorTheme(enabled ? selection[slotMode] : 'default', themes).id;
  return { id, dark: slotIsDark(id, slotMode, customSeed, themes) };
}

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
    localStorage.removeItem(COLOR_THEME_STORAGE_KEY);
    localStorage.removeItem(CUSTOM_THEME_STORAGE_KEY);
  } catch {}
}

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
