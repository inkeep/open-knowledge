/**
 * IDE color-theme plugin registry — the single source of truth for the built-in
 * palettes the Settings → Preferences picker offers, and the source the
 * `appearance.colorTheme` config enum is DERIVED from (`THEME_PLUGIN_IDS`, see
 * `config/schema.ts`). Lives in `core` (not `app`) precisely so the config
 * schema can derive its enum from the registry — `core` can't import `app`.
 *
 * This mirrors the content-rules `LintPlugin<Id, Slice>` registry: each entry is
 * a self-describing descriptor (`ThemePlugin`) the host iterates, and a plugin's
 * behavior (`toTokens`) lives on the descriptor the way `lint()` lives on a
 * `LintPlugin`. Adding a built-in theme = append one descriptor here; the config
 * enum, the picker list, and the generated CSS all follow with no edit elsewhere.
 *
 * Each non-`default` built-in is a self-contained palette — `dark` or `light`:
 * selecting one layers its tokens via a `data-color-theme` attribute on `<html>`
 * and forces its own mode (dark or light) so Tailwind `dark:` variants stay
 * correct. `default` carries no palette (defers to the light/dark
 * `appearance.theme` mode); `custom` is built at runtime from the user's seed
 * (app-side; see `buildCustomThemeCss`).
 *
 * The CSS that applies the built-in palettes is GENERATED from this registry into
 * `packages/app/src/color-themes.generated.css`; the app's `color-themes.test.ts`
 * regenerates and fails on drift.
 */

/** A theme's authored base colors. `expandPalette` derives every shadcn token from these. */
export interface ColorThemeBase {
  /** Editor canvas background. */
  bg: string;
  /** Elevated surfaces (cards, popovers, hover states). Lighter than `bg`. */
  bgElevated: string;
  /** Chrome / sidebar background. Darker than `bg` for the "island" depth cue. */
  bgSubtle: string;
  /** Primary body text. */
  fg: string;
  /** Secondary / descriptive text. Must stay legible on `bg`. */
  fgMuted: string;
  /** Hairline borders + inputs. */
  border: string;
  /** Accent for buttons, links, focus ring. */
  primary: string;
  /** Text painted on top of `primary` — pick for contrast. */
  primaryFg: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  cyan: string;
  orange: string;
  purple: string;
}

/**
 * A theme plugin descriptor — the theming analog of the content-rules
 * `LintPlugin`. The registry iterates these; consumers read behavior off the
 * descriptor rather than branching per-theme.
 */
export interface ThemePlugin<Id extends string = string> {
  /** Config value under `appearance.colorTheme`, and the picker tile key. */
  id: Id;
  /** Display name. A brand proper-noun (Dracula, Nord, …) — intentionally not translated. */
  label: string;
  /** `dark`/`light` palettes force that mode; `system` follows `appearance.theme`. */
  kind: 'dark' | 'light' | 'system';
  /** Authored colors. Absent on `default` (no palette) and `custom` (runtime seed). */
  base?: ColorThemeBase;
  /**
   * The plugin's behavior: derive the CSS token map this theme applies. Present
   * only on built-ins with a static `base` (the analog of `LintPlugin.lint`);
   * `default`/`custom` have none. The generated CSS calls this per descriptor.
   */
  toTokens?(): Record<string, string>;
}

const DRACULA: ColorThemeBase = {
  bg: '#282a36',
  bgElevated: '#343746',
  bgSubtle: '#21222c',
  fg: '#f8f8f2',
  fgMuted: '#9aa0c5',
  border: '#44475a',
  primary: '#bd93f9',
  primaryFg: '#282a36',
  red: '#ff5555',
  green: '#50fa7b',
  yellow: '#f1fa8c',
  blue: '#8be9fd',
  cyan: '#8be9fd',
  orange: '#ffb86c',
  purple: '#ff79c6',
};

// Catppuccin Frappé — the warm, mid-tone dark flavor. Mauve is the signature accent.
const CATPPUCCIN_FRAPPE: ColorThemeBase = {
  bg: '#303446', // base
  bgElevated: '#414559', // surface0
  bgSubtle: '#292c3c', // mantle
  fg: '#c6d0f5', // text
  fgMuted: '#a5adce', // subtext0
  border: '#51576d', // surface1
  primary: '#ca9ee6', // mauve
  primaryFg: '#303446', // base (reads on mauve)
  red: '#e78284',
  green: '#a6d189',
  yellow: '#e5c890',
  blue: '#8caaee',
  cyan: '#81c8be', // teal
  orange: '#ef9f76', // peach
  purple: '#ca9ee6', // mauve
};

// Catppuccin Latte — the light flavor. bgElevated is white so cards lift off the
// soft-gray canvas; bgSubtle is a touch darker for the sidebar "island" depth.
const CATPPUCCIN_LATTE: ColorThemeBase = {
  bg: '#eff1f5', // base
  bgElevated: '#ffffff', // white cards/popovers lift off the canvas
  bgSubtle: '#e6e9ef', // mantle (sidebar, slightly darker than base)
  fg: '#4c4f69', // text
  fgMuted: '#6c6f85', // subtext0
  border: '#ccd0da', // surface0
  primary: '#8839ef', // mauve
  primaryFg: '#ffffff', // white reads on mauve
  red: '#d20f39',
  green: '#40a02b',
  yellow: '#df8e1d',
  blue: '#1e66f5',
  cyan: '#179299', // teal
  orange: '#fe640b', // peach
  purple: '#8839ef', // mauve
};

const MONOKAI: ColorThemeBase = {
  bg: '#272822',
  bgElevated: '#31322b',
  bgSubtle: '#1e1f1a',
  fg: '#f8f8f2',
  fgMuted: '#a6a28c',
  border: '#49483e',
  primary: '#66d9ef',
  primaryFg: '#272822',
  red: '#f92672',
  green: '#a6e22e',
  yellow: '#e6db74',
  blue: '#66d9ef',
  cyan: '#66d9ef',
  orange: '#fd971f',
  purple: '#ae81ff',
};

const GRUVBOX: ColorThemeBase = {
  bg: '#282828',
  bgElevated: '#32302f',
  bgSubtle: '#1d2021',
  fg: '#ebdbb2',
  fgMuted: '#a89984',
  border: '#3c3836',
  primary: '#83a598',
  primaryFg: '#1d2021',
  red: '#fb4934',
  green: '#b8bb26',
  yellow: '#fabd2f',
  blue: '#83a598',
  cyan: '#8ec07c',
  orange: '#fe8019',
  purple: '#d3869b',
};

const SOLARIZED: ColorThemeBase = {
  bg: '#002b36',
  bgElevated: '#073642',
  bgSubtle: '#00252e',
  fg: '#93a1a1',
  fgMuted: '#6a7f86',
  border: '#0e4a56',
  primary: '#268bd2',
  primaryFg: '#fdf6e3',
  red: '#dc322f',
  green: '#859900',
  yellow: '#b58900',
  blue: '#268bd2',
  cyan: '#2aa198',
  orange: '#cb4b16',
  purple: '#6c71c4',
};

/**
 * Map a base palette to the full shadcn token set (token name → CSS value),
 * keyed without the leading `--`. Order is stable for deterministic CSS
 * generation. Alpha-derived tokens reference `var(--primary)` via relative
 * color syntax so they track the primary with no duplicated literal.
 */
export function expandPalette(b: ColorThemeBase): Record<string, string> {
  return {
    background: b.bg,
    foreground: b.fg,
    card: b.bgElevated,
    'card-foreground': b.fg,
    popover: b.bgElevated,
    'popover-foreground': b.fg,
    primary: b.primary,
    'primary-foreground': b.primaryFg,
    secondary: b.bgElevated,
    'secondary-foreground': b.fg,
    muted: b.bgElevated,
    'muted-foreground': b.fgMuted,
    accent: b.bgElevated,
    'accent-foreground': b.fg,
    destructive: b.red,
    border: b.border,
    input: b.border,
    ring: b.primary,
    'selection-soft': 'oklch(from var(--primary) l c h / 0.3)',
    'chart-1': b.primary,
    'chart-2': b.green,
    'chart-3': b.yellow,
    'chart-4': b.purple,
    'chart-5': b.red,
    sidebar: b.bgSubtle,
    'sidebar-foreground': b.fg,
    'sidebar-primary': b.primary,
    'sidebar-primary-foreground': b.primaryFg,
    'sidebar-accent': 'oklch(from var(--primary) l c h / 0.14)',
    'sidebar-accent-foreground': b.primary,
    'sidebar-hover': b.bgElevated,
    'sidebar-border': b.border,
    'sidebar-ring': b.primary,
    'syntax-keyword': b.purple,
    'syntax-tag': b.red,
    'syntax-attr': b.blue,
    'syntax-string': b.green,
    'syntax-number': b.orange,
    'syntax-atom': b.cyan,
  };
}

/** Build a `dark` built-in descriptor whose `toTokens` derives from its palette. */
function darkTheme<const Id extends string>(
  id: Id,
  label: string,
  base: ColorThemeBase,
): ThemePlugin<Id> {
  return { id, label, kind: 'dark', base, toTokens: () => expandPalette(base) };
}

/** Build a `light` built-in descriptor whose `toTokens` derives from its palette. */
function lightTheme<const Id extends string>(
  id: Id,
  label: string,
  base: ColorThemeBase,
): ThemePlugin<Id> {
  return { id, label, kind: 'light', base, toTokens: () => expandPalette(base) };
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
  darkTheme('dracula', 'Dracula', DRACULA),
  darkTheme('catppuccin-frappe', 'Catppuccin Frappé', CATPPUCCIN_FRAPPE),
  lightTheme('catppuccin-latte', 'Catppuccin Latte', CATPPUCCIN_LATTE),
  darkTheme('monokai', 'Monokai', MONOKAI),
  darkTheme('gruvbox', 'Gruvbox', GRUVBOX),
  darkTheme('solarized', 'Solarized', SOLARIZED),
  // `custom` carries no static `base`: its palette is built at runtime from the
  // user's `appearance.customTheme` seed (app-side `buildCustomThemeCss`). `kind`
  // is a placeholder — the real light/dark mode is derived per-seed. Excluded
  // from the generated CSS (no `toTokens`).
  systemTheme('custom', 'Custom'),
] as const;

/** A built-in theme's config id. DERIVED from the registry — the union of every entry's `id`. */
export type ThemePluginId = (typeof THEME_PLUGINS)[number]['id'];

/**
 * The theme ids as a non-empty tuple, DERIVED from the registry, for `z.enum` in
 * `config/schema.ts`. This is what makes `appearance.colorTheme` follow the
 * registry: add a `ThemePlugin` and the config enum grows with no schema edit
 * (the coupling the old hand-listed enum carried). The cast supplies the tuple
 * shape `z.enum` needs; the literal members come from the registry.
 */
export const THEME_PLUGIN_IDS = THEME_PLUGINS.map((t) => t.id) as [
  ThemePluginId,
  ...ThemePluginId[],
];

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
 * Render the generated stylesheet that applies every built-in palette. One rule
 * per dark theme, selected by `html[data-color-theme="<id>"]`. The attribute
 * selector out-specifies the base `:root` / `.dark` blocks, so a single block
 * per theme overrides both regardless of source order. `color-scheme` (the
 * theme's own kind) keeps native scrollbars / form controls correct even before
 * the `.dark` class settles on first paint. The descriptor's own `toTokens`
 * produces the tokens.
 */
export function generateColorThemesCss(): string {
  const header =
    '/* GENERATED by `bun run gen:color-themes` from src/lib/color-themes.ts — do not edit by hand. */\n';
  const blocks = THEME_PLUGINS.filter((t) => t.toTokens).map((theme) => {
    const tokens = (theme.toTokens as () => Record<string, string>)();
    const lines = Object.entries(tokens).map(([name, value]) => `  --${name}: ${value};`);
    const colorScheme = theme.kind === 'light' ? 'light' : 'dark';
    return `html[data-color-theme="${theme.id}"] {\n  color-scheme: ${colorScheme};\n${lines.join('\n')}\n}`;
  });
  return `${header}\n${blocks.join('\n\n')}\n`;
}
