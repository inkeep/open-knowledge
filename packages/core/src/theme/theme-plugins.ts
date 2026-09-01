import { type Base16Scheme, base16ToTokens } from './base16.ts';

export interface ThemePlugin<Id extends string = string> {
  id: Id;
  label: string;
  kind: 'dark' | 'light' | 'system';
  scheme?: Base16Scheme;
  toTokens?(): Record<string, string>;
}

const DRACULA: Base16Scheme = {
  name: 'Dracula',
  author: 'clach04 (https://github.com/clach04)',
  variant: 'dark',
  palette: {
    base00: '#282a36',
    base01: '#21222c',
    base02: '#44475a',
    base03: '#6272a4',
    base04: '#9ea8c7',
    base05: '#f8f8f2',
    base06: '#f8f8f2',
    base07: '#ffffff',
    base08: '#ff5555',
    base09: '#ffb86c',
    base0A: '#f1fa8c',
    base0B: '#50fa7b',
    base0C: '#8be9fd',
    base0D: '#bd93f9',
    base0E: '#ff79c6',
    base0F: '#993333',
  },
};

const CATPPUCCIN_FRAPPE: Base16Scheme = {
  name: 'Catppuccin Frappé',
  author: 'https://github.com/catppuccin/catppuccin',
  variant: 'dark',
  palette: {
    base00: '#303446',
    base01: '#292c3c',
    base02: '#414559',
    base03: '#51576d',
    base04: '#626880',
    base05: '#c6d0f5',
    base06: '#f2d5cf',
    base07: '#babbf1',
    base08: '#e78284',
    base09: '#ef9f76',
    base0A: '#e5c890',
    base0B: '#a6d189',
    base0C: '#81c8be',
    base0D: '#8caaee',
    base0E: '#ca9ee6',
    base0F: '#eebebe',
  },
};

const CATPPUCCIN_LATTE: Base16Scheme = {
  name: 'Catppuccin Latte',
  author: 'https://github.com/catppuccin/catppuccin',
  variant: 'light',
  palette: {
    base00: '#eff1f5',
    base01: '#e6e9ef',
    base02: '#ccd0da',
    base03: '#bcc0cc',
    base04: '#acb0be',
    base05: '#4c4f69',
    base06: '#dc8a78',
    base07: '#7287fd',
    base08: '#d20f39',
    base09: '#fe640b',
    base0A: '#df8e1d',
    base0B: '#40a02b',
    base0C: '#179299',
    base0D: '#1d62ec',
    base0E: '#8839ef',
    base0F: '#dd7878',
  },
};

const MONOKAI: Base16Scheme = {
  name: 'Monokai',
  author: 'Wimer Hazenberg (http://www.monokai.nl)',
  variant: 'dark',
  palette: {
    base00: '#272822',
    base01: '#383830',
    base02: '#49483e',
    base03: '#75715e',
    base04: '#a59f85',
    base05: '#f8f8f2',
    base06: '#f5f4f1',
    base07: '#f9f8f5',
    base08: '#f92672',
    base09: '#fd971f',
    base0A: '#f4bf75',
    base0B: '#a6e22e',
    base0C: '#a1efe4',
    base0D: '#66d9ef',
    base0E: '#ae81ff',
    base0F: '#cc6633',
  },
};

const GRUVBOX: Base16Scheme = {
  name: 'Gruvbox dark, medium',
  author: 'Dawid Kurek, morhetz (https://github.com/morhetz/gruvbox)',
  variant: 'dark',
  palette: {
    base00: '#282828',
    base01: '#3c3836',
    base02: '#504945',
    base03: '#665c54',
    base04: '#bdae93',
    base05: '#d5c4a1',
    base06: '#ebdbb2',
    base07: '#fbf1c7',
    base08: '#fb4934',
    base09: '#fe8019',
    base0A: '#fabd2f',
    base0B: '#b8bb26',
    base0C: '#8ec07c',
    base0D: '#83a598',
    base0E: '#d3869b',
    base0F: '#d65d0e',
  },
};

const SOLARIZED: Base16Scheme = {
  name: 'Solarized Dark',
  author: 'Ethan Schoonover (modified by aramisgithub)',
  variant: 'dark',
  palette: {
    base00: '#002b36',
    base01: '#073642',
    base02: '#586e75',
    base03: '#657b83',
    base04: '#839496',
    base05: '#93a1a1',
    base06: '#eee8d5',
    base07: '#fdf6e3',
    base08: '#dc322f',
    base09: '#cb4b16',
    base0A: '#b58900',
    base0B: '#859900',
    base0C: '#2aa198',
    base0D: '#2995e1',
    base0E: '#6c71c4',
    base0F: '#d33682',
  },
};

function builtIn<const Id extends string>(
  id: Id,
  label: string,
  scheme: Base16Scheme,
): ThemePlugin<Id> {
  return { id, label, kind: scheme.variant, scheme, toTokens: () => base16ToTokens(scheme) };
}

function systemTheme<const Id extends string>(id: Id, label: string): ThemePlugin<Id> {
  return { id, label, kind: 'system' };
}

export const THEME_PLUGINS = [
  systemTheme('default', 'Default'),
  builtIn('dracula', 'Dracula', DRACULA),
  builtIn('catppuccin-frappe', 'Catppuccin Frappé', CATPPUCCIN_FRAPPE),
  builtIn('catppuccin-latte', 'Catppuccin Latte', CATPPUCCIN_LATTE),
  builtIn('monokai', 'Monokai', MONOKAI),
  builtIn('gruvbox', 'Gruvbox', GRUVBOX),
  builtIn('solarized', 'Solarized', SOLARIZED),
  systemTheme('custom', 'Custom'),
] as const;

export type ThemePluginId = (typeof THEME_PLUGINS)[number]['id'];

export const THEME_PLUGIN_IDS = THEME_PLUGINS.map((t) => t.id) as [
  ThemePluginId,
  ...ThemePluginId[],
];

export const THEME_ID_PATTERN = /^[a-z0-9-]{1,32}$/;

export const SAVED_THEME_ID_PREFIX = 'saved-';

export type SavedThemeIdError = 'empty' | 'too-long' | 'invalid-chars';

export type SavedThemeIdResult = { ok: true; id: string } | { ok: false; code: SavedThemeIdError };

export type SavedThemeNameResult =
  | { ok: true; name: string; stem: string; id: string }
  | { ok: false; code: 'empty' };

const SAVED_THEME_STEM_MAX_LENGTH = 32 - SAVED_THEME_ID_PREFIX.length;
const COMBINING_MARK_RE = /\p{M}+/gu;
const APOSTROPHE_RE = /['\u2019\u02bc]+/gu;
const NON_ASCII_ALPHANUMERIC_RE = /[^a-z0-9]+/g;

function savedThemeNameHash(name: string): string {
  let hash = 0x811c9dc5;
  for (const character of name) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function deriveSavedThemeName(name: string): SavedThemeNameResult {
  const displayName = name.trim();
  if (displayName.length === 0) return { ok: false, code: 'empty' };

  const slug = displayName
    .normalize('NFKD')
    .replace(COMBINING_MARK_RE, '')
    .toLowerCase()
    .replace(APOSTROPHE_RE, '')
    .replace(NON_ASCII_ALPHANUMERIC_RE, '-')
    .replace(/^-+|-+$/g, '');
  const hash = savedThemeNameHash(displayName);
  const stem =
    slug.length === 0
      ? `theme-${hash}`
      : slug.length <= SAVED_THEME_STEM_MAX_LENGTH
        ? slug
        : `${slug.slice(0, SAVED_THEME_STEM_MAX_LENGTH - hash.length - 1).replace(/-+$/g, '')}-${hash}`;
  const derived = deriveSavedThemeId(stem);
  if (!derived.ok) throw new Error('Saved theme name derivation produced an invalid id');
  return { ok: true, name: displayName, stem, id: derived.id };
}

export function deriveSavedThemeId(stem: string): SavedThemeIdResult {
  if (stem.length === 0) return { ok: false, code: 'empty' };
  const id = SAVED_THEME_ID_PREFIX + stem;
  if (THEME_ID_PATTERN.test(id)) return { ok: true, id };
  return { ok: false, code: /^[a-z0-9-]+$/.test(id) ? 'too-long' : 'invalid-chars' };
}

export function parseSavedThemeId(id: string): { ok: true; stem: string } | { ok: false } {
  if (!THEME_ID_PATTERN.test(id)) return { ok: false };
  if (!id.startsWith(SAVED_THEME_ID_PREFIX)) return { ok: false };
  const stem = id.slice(SAVED_THEME_ID_PREFIX.length);
  if (stem.length === 0) return { ok: false };
  return { ok: true, stem };
}

const THEME_PLUGIN_BY_ID = new Map<string, ThemePlugin>(THEME_PLUGINS.map((t) => [t.id, t]));

export function resolveThemePlugin(id: string | undefined): ThemePlugin {
  return (id && THEME_PLUGIN_BY_ID.get(id)) || THEME_PLUGINS[0];
}

export function isDarkTheme(id: string | undefined): boolean {
  return resolveThemePlugin(id).kind === 'dark';
}

export function colorThemeMode(id: string | undefined): 'light' | 'dark' | undefined {
  const kind = resolveThemePlugin(id).kind;
  return kind === 'system' ? undefined : kind;
}

export interface ColorThemeSelection {
  light: string;
  dark: string;
}

export interface ColorThemeSelectionInput {
  colorTheme?: string | undefined;
  colorThemeLight?: string | undefined;
  colorThemeDark?: string | undefined;
}

export function resolveColorThemeSelection(
  appearance: ColorThemeSelectionInput | undefined,
  themes: readonly ThemePlugin[] = THEME_PLUGINS,
): ColorThemeSelection {
  const availableIds = new Set(themes.map((theme) => theme.id));
  const legacy = appearance?.colorTheme;
  const fallback = legacy && availableIds.has(legacy) ? legacy : THEME_PLUGINS[0].id;
  const pick = (value: string | undefined): string => {
    if (value === undefined) return fallback;
    return availableIds.has(value) ? value : THEME_PLUGINS[0].id;
  };
  return {
    light: pick(appearance?.colorThemeLight),
    dark: pick(appearance?.colorThemeDark),
  };
}

export function resolveModePreference(
  preference: string | undefined,
  prefersDark: boolean,
): 'light' | 'dark' {
  if (preference === 'light' || preference === 'dark') return preference;
  return prefersDark ? 'dark' : 'light';
}

export function renderThemeBlock(
  selector: string,
  variant: 'dark' | 'light',
  tokens: Record<string, string>,
): string {
  const lines = Object.entries(tokens).map(([name, value]) => `  --${name}: ${value};`);
  return `${selector} {\n  color-scheme: ${variant};\n${lines.join('\n')}\n}`;
}

export function generateColorThemesCss(): string {
  const header =
    '/* GENERATED by `pnpm run gen:color-themes` from packages/core/src/theme/theme-plugins.ts — do not edit by hand. */\n';
  const blocks = THEME_PLUGINS.filter((t) => t.toTokens).map((theme) =>
    renderThemeBlock(
      `html[data-color-theme="${theme.id}"]`,
      theme.kind === 'light' ? 'light' : 'dark',
      (theme.toTokens as () => Record<string, string>)(),
    ),
  );
  return `${header}\n${blocks.join('\n\n')}\n`;
}
