/**
 * App-facing barrel for the IDE color themes.
 *
 * The built-in theme registry + its pure token logic now live in
 * `@inkeep/open-knowledge-core` (`theme/theme-plugins.ts`) as a `ThemePlugin`
 * registry — moved there so the `appearance.colorTheme` config enum can be
 * DERIVED from it (core can't import app). This module re-exports those under the
 * app's existing names and keeps the **custom theme** seed logic, which is
 * app-only (built at runtime from the user's six-color seed; not part of the
 * built-in plugin registry).
 */

import {
  CHROME_BG_DARK,
  CHROME_BG_LIGHT,
  type ColorThemeBase,
  colorThemeMode,
  expandPalette,
  generateColorThemesCss,
  isDarkTheme,
  PREVIEW_THEME_TOKENS,
  resolveThemePlugin,
  THEME_PLUGINS,
  type ThemePlugin,
} from '@inkeep/open-knowledge-core';

export type { ColorThemeBase };
// Re-export the core registry + pure token logic under the app's existing names.
export {
  colorThemeMode,
  expandPalette,
  generateColorThemesCss,
  isDarkTheme as isDarkColorTheme,
  resolveThemePlugin as resolveColorTheme,
  THEME_PLUGINS as COLOR_THEMES,
};
export type ColorTheme = ThemePlugin;

// ---------------------------------------------------------------------------
// Default theme — the base `:root` / `.dark` palette (`colorTheme: 'default'`).
//
// `default` carries no `ColorThemeBase`: its palette is the app's own stylesheet.
// A preview of it therefore can't read `var(--background)` & co., because a
// selected palette overrides exactly those custom properties on `<html>` and the
// preview inherits the override — the preview would mirror whatever theme is
// active instead of showing what `default` looks like. So resolve the handful of
// tokens a preview needs to literals, sourced from the chrome-background
// constants (`CHROME_BG_*`) and the preview-token snapshot
// (`PREVIEW_THEME_TOKENS`) — both generated from, and drift-checked against,
// `globals.css`.
// ---------------------------------------------------------------------------

/** Literal light/dark values per `globals.css` preview token, keyed by token name. */
const PREVIEW_TOKEN_BY_NAME = new Map(PREVIEW_THEME_TOKENS.map((token) => [token.name, token]));

function baseToken(name: string, mode: 'light' | 'dark'): string {
  const token = PREVIEW_TOKEN_BY_NAME.get(name);
  if (!token) throw new Error(`color-themes: ${name} is not a generated base-theme token`);
  return token[mode];
}

/**
 * The subset of `expandPalette`-shaped tokens describing the default theme in a
 * given light/dark mode, so a preview can paint it the same way it paints a
 * built-in palette. `--sidebar` comes from the chrome constants (the same token
 * the window chrome uses); the rest from the preview-token set. Syntax colors
 * map onto the chart palette — the base theme's own `--syntax-*` tokens resolve
 * through Tailwind color vars, which don't survive as literals here.
 */
export function defaultThemeTokens(mode: 'light' | 'dark'): Record<string, string> {
  return {
    sidebar: mode === 'dark' ? CHROME_BG_DARK : CHROME_BG_LIGHT,
    background: baseToken('--background', mode),
    primary: baseToken('--primary', mode),
    border: baseToken('--border', mode),
    'syntax-string': baseToken('--chart-2', mode),
    'syntax-keyword': baseToken('--chart-4', mode),
    'syntax-atom': baseToken('--chart-3', mode),
  };
}

// ---------------------------------------------------------------------------
// Custom theme — the user's own palette (`appearance.colorTheme: 'custom'`).
//
// Unlike the built-ins, a custom palette is unknown at build time, so its CSS
// is generated at runtime from a six-color seed and injected as a <style> tag
// (see `useApplyConfigColorTheme`). The seed expands to a full `ColorThemeBase`
// here, then through the same `expandPalette` the built-ins use — one
// token-mapping source for both.
// ---------------------------------------------------------------------------

/** The six user-editable seed colors for the custom theme. All `#rrggbb`. */
export interface CustomThemeSeed {
  /** Editor canvas background. */
  background: string;
  /** Elevated surfaces — cards, sidebar, popovers. */
  surface: string;
  /** Primary text. */
  foreground: string;
  /** Accent for buttons, links, focus ring. */
  primary: string;
  /** Secondary accent — syntax highlights, charts. */
  accent: string;
  /** Hairline borders + inputs. */
  border: string;
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** A tasteful slate/indigo dark default so a fresh custom theme is usable immediately. */
export const DEFAULT_CUSTOM_SEED: CustomThemeSeed = {
  background: '#0f172a',
  surface: '#1e293b',
  foreground: '#e2e8f0',
  primary: '#6366f1',
  accent: '#22d3ee',
  border: '#334155',
};

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_RE.test(value);
}

/**
 * Merge a (possibly partial / hand-edited) config seed over the default,
 * dropping any field that isn't a valid `#rrggbb` hex so a typo can't break the
 * whole palette.
 */
export function resolveCustomSeed(
  partial: Partial<Record<keyof CustomThemeSeed, unknown>> | undefined,
): CustomThemeSeed {
  const seed = { ...DEFAULT_CUSTOM_SEED };
  if (partial) {
    for (const key of Object.keys(DEFAULT_CUSTOM_SEED) as (keyof CustomThemeSeed)[]) {
      const v = partial[key];
      if (isHexColor(v)) seed[key] = v;
    }
  }
  return seed;
}

/** sRGB relative luminance (WCAG) of a `#rrggbb` color, 0 (black) … 1 (white). */
export function relativeLuminance(hex: string): number {
  const h = isHexColor(hex) ? hex : '#000000';
  const channel = (i: number) => {
    const c = Number.parseInt(h.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/** A custom seed is dark when its background is dark — drives the `.dark` class + `color-scheme`. */
export function customThemeKind(seed: CustomThemeSeed): 'light' | 'dark' {
  return relativeLuminance(seed.background) < 0.5 ? 'dark' : 'light';
}

/** Text color that reads on top of `bg` — white on dark, near-black on light. */
function contrastingText(bg: string): string {
  return relativeLuminance(bg) < 0.5 ? '#ffffff' : '#0a0a0a';
}

/**
 * Expand the six-color seed into a full `ColorThemeBase`. Text-on-accent and
 * muted text are derived (luminance pick + `color-mix`); the semantic accent
 * hues (red/green/yellow/orange) are fixed, legible-on-either-mode defaults,
 * while blue/cyan/purple track the user's `accent` so syntax + charts stay
 * on-brand.
 */
export function expandCustomSeed(seed: CustomThemeSeed): ColorThemeBase {
  return {
    bg: seed.background,
    bgElevated: seed.surface,
    bgSubtle: seed.surface,
    fg: seed.foreground,
    fgMuted: `color-mix(in oklab, ${seed.foreground} 55%, ${seed.background})`,
    border: seed.border,
    primary: seed.primary,
    primaryFg: contrastingText(seed.primary),
    red: '#e5534b',
    green: '#3fb950',
    yellow: '#d29922',
    blue: seed.accent,
    cyan: seed.accent,
    orange: '#db8d3f',
    purple: seed.accent,
  };
}

/**
 * Build the runtime stylesheet for the active custom theme: one
 * `html[data-color-theme="custom"]` rule with the full expanded token set and a
 * `color-scheme` matching the seed's light/dark kind.
 */
export function buildCustomThemeCss(seed: CustomThemeSeed): string {
  const tokens = expandPalette(expandCustomSeed(seed));
  const lines = Object.entries(tokens).map(([name, value]) => `  --${name}: ${value};`);
  return `html[data-color-theme="custom"] {\n  color-scheme: ${customThemeKind(seed)};\n${lines.join('\n')}\n}`;
}
