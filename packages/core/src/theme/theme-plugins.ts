/**
 * IDE color-theme plugin registry — the single source of truth for the built-in
 * palettes the Settings → Preferences picker offers. Config accepts the open,
 * shape-constrained id grammar declared below so user-owned saved themes can
 * participate without extending this registry. This lives in `core` (not
 * `app`) so config validation and app resolution share the same contracts.
 *
 * This mirrors the content-rules `LintPlugin<Id, Slice>` registry: each entry is
 * a self-describing descriptor (`ThemePlugin`) the host iterates, and a plugin's
 * behavior (`toTokens`) lives on the descriptor the way `lint()` lives on a
 * `LintPlugin`. Adding a built-in theme = append one descriptor here; the config
 * enum, the picker list, and the generated CSS all follow with no edit elsewhere.
 *
 * Every palette is a `Base16Scheme` (see `base16.ts`) reproduced verbatim from
 * the upstream Tinted Theming scheme of the same name, so a built-in and a
 * user-imported scheme travel the exact same code path. Selecting one layers its
 * tokens via a `data-color-theme` attribute on `<html>` and forces the scheme's
 * own `variant` so Tailwind `dark:` variants stay correct. `default` carries no
 * palette (defers to the light/dark `appearance.theme` mode); `custom` is built
 * at runtime from the user's imported or hand-edited scheme.
 *
 * The CSS that applies the built-in palettes is GENERATED from this registry into
 * `packages/app/src/color-themes.generated.css`; the app's `color-themes.test.ts`
 * regenerates and fails on drift.
 */

import { type Base16Scheme, base16ToTokens } from './base16.ts';

/**
 * A theme plugin descriptor — the theming analog of the content-rules
 * `LintPlugin`. The registry iterates these; consumers read behavior off the
 * descriptor rather than branching per-theme.
 */
export interface ThemePlugin<Id extends string = string> {
  /** Palette id used by appearance config and picker tiles. */
  id: Id;
  /** Display name. A brand proper-noun (Dracula, Nord, …) — intentionally not translated. */
  label: string;
  /** `dark`/`light` palettes force that mode; `system` follows `appearance.theme`. */
  kind: 'dark' | 'light' | 'system';
  /** The authored scheme. Absent on `default` (no palette) and `custom` (runtime import). */
  scheme?: Base16Scheme;
  /**
   * The plugin's behavior: derive the CSS token map this theme applies. Present
   * only on built-ins with a static `scheme` (the analog of `LintPlugin.lint`);
   * `default`/`custom` have none. The generated CSS calls this per descriptor.
   */
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
    base0D: '#1e66f5',
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
    base0D: '#268bd2',
    base0E: '#6c71c4',
    base0F: '#d33682',
  },
};

/**
 * Build a built-in descriptor from a scheme. `kind` comes from the scheme's own
 * `variant` — a light scheme forces light mode, not merely "not dark".
 */
function builtIn<const Id extends string>(
  id: Id,
  label: string,
  scheme: Base16Scheme,
): ThemePlugin<Id> {
  return { id, label, kind: scheme.variant, scheme, toTokens: () => base16ToTokens(scheme) };
}

/** Build a `system`-kind descriptor (no static palette): `default` and `custom`. */
function systemTheme<const Id extends string>(id: Id, label: string): ThemePlugin<Id> {
  return { id, label, kind: 'system' };
}

/**
 * The built-in theme registry, in display + execution order. `default` first so
 * it anchors the picker grid. Order here drives both the Settings tile order and
 * the generated CSS order.
 */
export const THEME_PLUGINS = [
  systemTheme('default', 'Default'),
  builtIn('dracula', 'Dracula', DRACULA),
  builtIn('catppuccin-frappe', 'Catppuccin Frappé', CATPPUCCIN_FRAPPE),
  builtIn('catppuccin-latte', 'Catppuccin Latte', CATPPUCCIN_LATTE),
  builtIn('monokai', 'Monokai', MONOKAI),
  builtIn('gruvbox', 'Gruvbox', GRUVBOX),
  builtIn('solarized', 'Solarized', SOLARIZED),
  // `custom` carries no static scheme: its palette is built at runtime from the
  // user's `appearance.customTheme` (an imported or hand-edited base16 scheme).
  // `kind` is a placeholder — the real mode comes from the scheme's `variant`.
  // Excluded from the generated CSS (no `toTokens`).
  systemTheme('custom', 'Custom'),
] as const;

/** A built-in theme's config id. DERIVED from the registry — the union of every entry's `id`. */
export type ThemePluginId = (typeof THEME_PLUGINS)[number]['id'];

/**
 * The built-in theme ids as a non-empty tuple derived from the registry.
 * Config metadata uses this list for built-in suggestions while validation
 * remains open to any id admitted by `THEME_ID_PATTERN`.
 */
export const THEME_PLUGIN_IDS = THEME_PLUGINS.map((t) => t.id) as [
  ThemePluginId,
  ...ThemePluginId[],
];

/**
 * The grammar every theme id must satisfy: lowercase letters, digits, and
 * hyphens, 1–32 characters. The config fields that name a palette
 * (`appearance.colorThemeLight` / `colorThemeDark` / the retired `colorTheme`)
 * are shape-constrained to this rather than to a closed set of built-in ids, so
 * a palette the built-in registry has never heard of — a user's saved theme —
 * validates and resolves to `default` at read time instead of failing
 * whole-config validation and discarding every other user preference.
 *
 * The FOUC pre-paint script inlined in `packages/app/index.html` validates ids
 * against this exact shape but can't import it (it runs before any bundle
 * loads), so it hardcodes the pattern. The two MUST stay identical — a palette
 * config accepts but pre-paint rejects would flash unstyled on reload — and a
 * drift test in the app pins the inline copy to this source.
 */
export const THEME_ID_PATTERN = /^[a-z0-9-]{1,32}$/;

/**
 * Reserved prefix that namespaces a saved theme's palette id. A built-in id must
 * never begin with it (a registry-invariant test enforces this), so a saved
 * theme can never shadow a built-in and resolution order never has to arbitrate
 * between the two.
 *
 * The prefix is itself `[a-z0-9-]`, so `saved-<stem>` stays admissible to
 * `THEME_ID_PATTERN` — the config fields and the FOUC pre-paint script keep
 * validating against the one grammar with no namespace separator to learn.
 */
export const SAVED_THEME_ID_PREFIX = 'saved-';

/** Why a filename stem (or a proposed save name) could not become a saved-theme id. */
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

/**
 * Turn a human-facing theme name into its safe filename identity while keeping
 * the display name intact. Common punctuation becomes word boundaries, while
 * apostrophes disappear so "John's theme" maps naturally to `johns-theme`.
 * Names that cannot fit the storage grammar receive a stable hash suffix rather
 * than being refused or silently colliding through plain truncation.
 */
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

/**
 * Derive a saved theme's palette id from a filename stem:
 * `SAVED_THEME_ID_PREFIX` + stem, admitted only if the whole id satisfies
 * `THEME_ID_PATTERN`. A stem that overflows the id's length budget, or carries
 * characters outside the grammar, is REFUSED with a distinguishing code — never
 * truncated or rewritten to fit. The caller lists such a file in an error state
 * when scanning a hand-dropped file. User-facing names route through
 * `deriveSavedThemeName` instead.
 */
export function deriveSavedThemeId(stem: string): SavedThemeIdResult {
  if (stem.length === 0) return { ok: false, code: 'empty' };
  const id = SAVED_THEME_ID_PREFIX + stem;
  if (THEME_ID_PATTERN.test(id)) return { ok: true, id };
  // The grammar rejected it; name the fixable cause. A well-formed-but-overlong
  // id passes the character class and fails only the length bound, so a clean
  // charset match localizes the fault to length; anything else is stray characters.
  return { ok: false, code: /^[a-z0-9-]+$/.test(id) ? 'too-long' : 'invalid-chars' };
}

/**
 * Recover a saved theme's filename stem from its palette id — the inverse of
 * `deriveSavedThemeId`. Succeeds only for a well-formed saved-theme id: it must
 * satisfy `THEME_ID_PATTERN`, carry the `SAVED_THEME_ID_PREFIX`, and leave a
 * non-empty stem after the prefix. A built-in id (no prefix) or a bare `saved-`
 * (empty stem) yields `{ ok: false }`. Because the stem is `[a-z0-9-]+` by
 * construction, callers may use it as a filename segment without further
 * path-safety escaping.
 */
export function parseSavedThemeId(id: string): { ok: true; stem: string } | { ok: false } {
  if (!THEME_ID_PATTERN.test(id)) return { ok: false };
  if (!id.startsWith(SAVED_THEME_ID_PREFIX)) return { ok: false };
  const stem = id.slice(SAVED_THEME_ID_PREFIX.length);
  if (stem.length === 0) return { ok: false };
  return { ok: true, stem };
}

const THEME_PLUGIN_BY_ID = new Map<string, ThemePlugin>(THEME_PLUGINS.map((t) => [t.id, t]));

/** Resolve a raw config value to a known theme, falling back to `default`. */
export function resolveThemePlugin(id: string | undefined): ThemePlugin {
  return (id && THEME_PLUGIN_BY_ID.get(id)) || THEME_PLUGINS[0];
}

/** True for every theme whose palette forces dark mode. */
export function isDarkTheme(id: string | undefined): boolean {
  return resolveThemePlugin(id).kind === 'dark';
}

/**
 * The light/dark mode a palette theme forces, or `undefined` for a `system`-kind
 * theme (`default`/`custom`) that defers to `appearance.theme`. This is what lets
 * a light built-in force light mode instead of merely "not dark".
 */
export function colorThemeMode(id: string | undefined): 'light' | 'dark' | undefined {
  const kind = resolveThemePlugin(id).kind;
  return kind === 'system' ? undefined : kind;
}

/**
 * The palette to apply in each light/dark mode — one theme id per mode. The id
 * is a shape-constrained string, not the closed built-in set: the config fields
 * it is read from accept a user's saved-theme id too.
 */
export interface ColorThemeSelection {
  light: string;
  dark: string;
}

/** The `appearance` fields the selection is resolved from. */
export interface ColorThemeSelectionInput {
  colorTheme?: string | undefined;
  colorThemeLight?: string | undefined;
  colorThemeDark?: string | undefined;
}

/**
 * Resolve the light/dark palette pair from config.
 *
 * `colorThemeLight`/`colorThemeDark` are the live fields. A config that predates
 * them carries the single `colorTheme` instead, and seeding BOTH slots from it
 * is what makes the upgrade invisible: the one palette applies in either mode,
 * and — because a palette still forces its own variant — the app renders exactly
 * what it rendered before the pair existed. A half-written pair (one slot only)
 * falls back per-slot rather than discarding the other.
 *
 * Callers resolving saved-theme ids must pass the complete merged registry;
 * the default registry contains built-in themes only.
 */
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

/**
 * The light/dark mode a mode PREFERENCE resolves to. `system` defers to the OS,
 * which the caller supplies — core has no DOM.
 */
export function resolveModePreference(
  preference: string | undefined,
  prefersDark: boolean,
): 'light' | 'dark' {
  if (preference === 'light' || preference === 'dark') return preference;
  return prefersDark ? 'dark' : 'light';
}

/**
 * Render one `html[data-color-theme="<id>"]` block. The attribute selector
 * out-specifies the base `:root` / `.dark` blocks, so a single block per theme
 * overrides both regardless of source order. `color-scheme` keeps native
 * scrollbars / form controls correct even before the `.dark` class settles on
 * first paint.
 */
export function renderThemeBlock(
  selector: string,
  variant: 'dark' | 'light',
  tokens: Record<string, string>,
): string {
  const lines = Object.entries(tokens).map(([name, value]) => `  --${name}: ${value};`);
  return `${selector} {\n  color-scheme: ${variant};\n${lines.join('\n')}\n}`;
}

/**
 * Render the generated stylesheet that applies every built-in palette. The
 * descriptor's own `toTokens` produces the tokens.
 */
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
