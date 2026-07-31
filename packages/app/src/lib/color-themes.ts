/**
 * App-facing barrel for the IDE color themes.
 *
 * The built-in theme registry + its pure token logic live in
 * `@inkeep/open-knowledge-core` (`theme/theme-plugins.ts` + `theme/base16.ts`)
 * as a `ThemePlugin` registry — moved there so the `appearance.colorTheme`
 * config enum can be DERIVED from it (core can't import app). This module
 * re-exports those under the app's existing names and keeps the **custom
 * theme** resolution, which is app-only (built at runtime from the user's
 * imported or hand-edited scheme; not part of the built-in registry).
 */

import {
  BASE16_SLOTS,
  type Base16Palette,
  type Base16Scheme,
  base16ToTokens,
  CHROME_BG_DARK,
  CHROME_BG_LIGHT,
  colorThemeMode,
  generateColorThemesCss,
  isBase16Hex,
  isDarkTheme,
  mixHex,
  PREVIEW_THEME_TOKENS,
  relativeLuminance,
  renderThemeBlock,
  resolveThemePlugin,
  THEME_PLUGINS,
  type ThemePlugin,
} from '@inkeep/open-knowledge-core';

export type { Base16Scheme };
// Re-export the core registry + pure token logic under the app's existing names.
export {
  base16ToTokens,
  colorThemeMode,
  generateColorThemesCss,
  isDarkTheme as isDarkColorTheme,
  relativeLuminance,
  resolveThemePlugin as resolveColorTheme,
  THEME_PLUGINS as COLOR_THEMES,
};
export type ColorTheme = ThemePlugin;

// ---------------------------------------------------------------------------
// Default theme — the base `:root` / `.dark` palette (`colorTheme: 'default'`).
//
// `default` carries no scheme: its palette is the app's own stylesheet. A
// preview of it therefore can't read `var(--background)` & co., because a
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
 * The subset of `base16ToTokens`-shaped tokens describing the default theme in a
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
// Custom theme — the user's own scheme (`appearance.colorTheme: 'custom'`).
//
// Unlike the built-ins, a custom palette is unknown at build time, so its CSS
// is generated at runtime and injected as a <style> tag (see
// `useApplyConfigColorTheme`). It runs through the same `base16ToTokens` the
// built-ins use — one token-mapping source for both, so an imported scheme and
// a shipped one are indistinguishable downstream.
// ---------------------------------------------------------------------------

/** A tasteful slate/indigo dark scheme so a fresh custom theme is usable immediately. */
export const DEFAULT_CUSTOM_SCHEME: Base16Scheme = {
  name: 'Custom',
  variant: 'dark',
  palette: {
    base00: '#0f172a',
    base01: '#1e293b',
    base02: '#334155',
    base03: '#64748b',
    base04: '#94a3b8',
    base05: '#e2e8f0',
    base06: '#f1f5f9',
    base07: '#f8fafc',
    base08: '#e5534b',
    base09: '#db8d3f',
    base0A: '#d29922',
    base0B: '#3fb950',
    base0C: '#22d3ee',
    base0D: '#6366f1',
    base0E: '#a78bfa',
    base0F: '#c2703f',
  },
};

/**
 * The pre-base16 custom-theme shape: six seed colors the app expanded into a
 * full palette. Config written by an older build still carries it, so it is
 * upgraded on read rather than discarded.
 */
interface LegacyCustomSeed {
  background: string;
  surface: string;
  foreground: string;
  primary: string;
  accent: string;
  border: string;
}

const LEGACY_SEED_KEYS: (keyof LegacyCustomSeed)[] = [
  'background',
  'surface',
  'foreground',
  'primary',
  'accent',
  'border',
];

/**
 * Widen a legacy six-color seed into a scheme. The tonal ramp is interpolated
 * between the seed's background and foreground; the accent slots reproduce the
 * old expansion exactly — `primary` took the blue slot, `accent` drove
 * cyan/purple, and red/green/yellow/orange were fixed legible defaults.
 */
function schemeFromLegacySeed(seed: LegacyCustomSeed): Base16Scheme {
  const { background: bg, foreground: fg } = seed;
  return {
    name: 'Custom',
    variant: relativeLuminance(bg) < relativeLuminance(fg) ? 'dark' : 'light',
    palette: {
      base00: bg,
      base01: seed.surface,
      base02: seed.border,
      base03: mixHex(bg, fg, 0.4),
      base04: mixHex(bg, fg, 0.55),
      base05: fg,
      base06: mixHex(fg, '#ffffff', 0.3),
      base07: mixHex(fg, '#ffffff', 0.6),
      base08: '#e5534b',
      base09: '#db8d3f',
      base0A: '#d29922',
      base0B: '#3fb950',
      base0C: seed.accent,
      base0D: seed.primary,
      base0E: seed.accent,
      base0F: mixHex('#e5534b', bg, 0.35),
    },
  };
}

export function isHexColor(value: unknown): value is string {
  return isBase16Hex(value);
}

type CustomThemeInput = Record<string, unknown> | undefined;

/** The default scheme expressed in the legacy seed's vocabulary. */
function defaultLegacySeed(): LegacyCustomSeed {
  const p = DEFAULT_CUSTOM_SCHEME.palette;
  return {
    background: p.base00,
    surface: p.base01,
    foreground: p.base05,
    primary: p.base0D,
    accent: p.base0C,
    border: p.base02,
  };
}

/**
 * Collect whatever legacy seed fields a config carries, over the default.
 *
 * Partial is the common case, not an error: the old editor wrote only the
 * fields a user changed, and a hand-edited config may set one. Returns `null`
 * only when no legacy field is present at all, so the caller can tell "nothing
 * to upgrade" from "upgrade this".
 */
function readLegacySeed(partial: Record<string, unknown>): LegacyCustomSeed | null {
  const seed = defaultLegacySeed();
  let found = false;
  for (const key of LEGACY_SEED_KEYS) {
    const v = partial[key];
    // A malformed value is dropped rather than propagated, so one typo can't
    // break the whole palette.
    if (isBase16Hex(v)) {
      seed[key] = v;
      found = true;
    }
  }
  return found ? seed : null;
}

/** True when a config still carries any of the pre-base16 seed colors. */
export function hasLegacyCustomSeed(partial: CustomThemeInput): boolean {
  return partial ? LEGACY_SEED_KEYS.some((key) => isBase16Hex(partial[key])) : false;
}

/**
 * Resolve a (possibly partial / hand-edited / legacy) config value into a
 * scheme.
 *
 * Precedence is layered, lowest first: the default scheme, then a pre-base16
 * six-color seed upgraded into slots, then any explicit base16 slot. The
 * middle layer is what makes a half-migrated config safe — a user who had a
 * custom theme and then nudges ONE slot in the new editor keeps the other
 * fifteen instead of having them snap back to the default. Malformed values
 * are dropped at every layer, so one typo can't break the whole palette.
 */
export function resolveCustomScheme(partial: CustomThemeInput): Base16Scheme {
  if (!partial) return DEFAULT_CUSTOM_SCHEME;

  const legacy = readLegacySeed(partial);
  const base = legacy ? schemeFromLegacySeed(legacy) : DEFAULT_CUSTOM_SCHEME;

  const palette = { ...base.palette } as Base16Palette;
  for (const slot of BASE16_SLOTS) {
    const v = partial[slot];
    if (isBase16Hex(v)) palette[slot] = v;
  }
  const variant =
    partial.variant === 'light' || partial.variant === 'dark'
      ? partial.variant
      : relativeLuminance(palette.base00) < relativeLuminance(palette.base05)
        ? 'dark'
        : 'light';
  return {
    name: typeof partial.name === 'string' && partial.name.trim() ? partial.name.trim() : 'Custom',
    author: typeof partial.author === 'string' ? partial.author : undefined,
    variant,
    palette,
  };
}

/**
 * The `appearance.customTheme` patch that writes `scheme` in full and retires
 * the pre-base16 seed keys.
 *
 * `null` deletes a key in a config patch, so a config that still carries the
 * old six colors is normalized to pure base16 the first time the user changes
 * anything — no stale half-format left behind, and no `ok config migrate` for
 * what is only a personal color preference.
 */
export function customThemeWritePatch(scheme: Base16Scheme): Record<string, string | null> {
  const out: Record<string, string | null> = {
    name: scheme.name,
    // A scheme without a credit line must clear a previous one, or the author
    // of an imported scheme would outlive the scheme it credited.
    author: scheme.author ?? null,
    variant: scheme.variant,
  };
  for (const slot of BASE16_SLOTS) out[slot] = scheme.palette[slot];
  for (const key of LEGACY_SEED_KEYS) out[key] = null;
  return out;
}

/** A custom scheme's forced light/dark mode — drives the `.dark` class + `color-scheme`. */
export function customThemeKind(scheme: Base16Scheme): 'light' | 'dark' {
  return scheme.variant;
}

/**
 * Build the runtime stylesheet for the active custom theme: one
 * `html[data-color-theme="custom"]` rule with the full expanded token set and a
 * `color-scheme` matching the scheme's variant.
 */
export function buildCustomThemeCss(scheme: Base16Scheme): string {
  return renderThemeBlock(
    'html[data-color-theme="custom"]',
    scheme.variant,
    base16ToTokens(scheme),
  );
}
