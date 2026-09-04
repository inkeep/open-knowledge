import {
  BASE16_SLOTS,
  type Base16Palette,
  type Base16Scheme,
  base16ToTokens,
  CHROME_BG_DARK,
  CHROME_BG_LIGHT,
  type ColorThemeSelection,
  type ColorThemeSelectionInput,
  generateColorThemesCss,
  isBase16Hex,
  isDarkTheme,
  mixHex,
  PREVIEW_THEME_TOKENS,
  relativeLuminance,
  renderThemeBlock,
  resolveColorThemeSelection,
  resolveModePreference,
  resolveThemePlugin,
  THEME_PLUGINS,
  type ThemePlugin,
} from '@inkeep/open-knowledge-core';

export type { Base16Scheme, ColorThemeSelection, ColorThemeSelectionInput };
export {
  base16ToTokens,
  generateColorThemesCss,
  isDarkTheme as isDarkColorTheme,
  relativeLuminance,
  resolveColorThemeSelection,
  resolveModePreference,
  THEME_PLUGINS as COLOR_THEMES,
};
export type ColorTheme = ThemePlugin;

export function resolveColorTheme(
  id: string | undefined,
  themes: readonly ColorTheme[] = THEME_PLUGINS,
): ColorTheme {
  return themes.find((theme) => theme.id === id) ?? resolveThemePlugin(id);
}

export function colorThemeMode(
  id: string | undefined,
  themes: readonly ColorTheme[] = THEME_PLUGINS,
): 'light' | 'dark' | undefined {
  const kind = resolveColorTheme(id, themes).kind;
  return kind === 'system' ? undefined : kind;
}

export function colorThemeWritePatch(next: ColorThemeSelection): {
  colorThemeLight: string;
  colorThemeDark: string;
  colorTheme: null;
} {
  return { colorThemeLight: next.light, colorThemeDark: next.dark, colorTheme: null };
}

export function colorThemeResetPatch(): {
  colorThemeLight: null;
  colorThemeDark: null;
  colorTheme: null;
} {
  return { colorThemeLight: null, colorThemeDark: null, colorTheme: null };
}

const PREVIEW_TOKEN_BY_NAME = new Map(PREVIEW_THEME_TOKENS.map((token) => [token.name, token]));

function baseToken(name: string, mode: 'light' | 'dark'): string {
  const token = PREVIEW_TOKEN_BY_NAME.get(name);
  if (!token) throw new Error(`color-themes: ${name} is not a generated base-theme token`);
  return token[mode];
}

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

function readLegacySeed(partial: Record<string, unknown>): LegacyCustomSeed | null {
  const seed = defaultLegacySeed();
  let found = false;
  for (const key of LEGACY_SEED_KEYS) {
    const v = partial[key];
    if (isBase16Hex(v)) {
      seed[key] = v;
      found = true;
    }
  }
  return found ? seed : null;
}

export function hasLegacyCustomSeed(partial: CustomThemeInput): boolean {
  return partial ? LEGACY_SEED_KEYS.some((key) => isBase16Hex(partial[key])) : false;
}

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

export function customThemeWritePatch(scheme: Base16Scheme): Record<string, string | null> {
  const out: Record<string, string | null> = {
    name: scheme.name,
    author: scheme.author ?? null,
    variant: scheme.variant,
  };
  for (const slot of BASE16_SLOTS) out[slot] = scheme.palette[slot];
  for (const key of LEGACY_SEED_KEYS) out[key] = null;
  return out;
}

export function customThemeKind(scheme: Base16Scheme): 'light' | 'dark' {
  return scheme.variant;
}

export function buildCustomThemeCss(scheme: Base16Scheme): string {
  return renderThemeBlock(
    'html[data-color-theme="custom"]',
    scheme.variant,
    base16ToTokens(scheme),
  );
}
