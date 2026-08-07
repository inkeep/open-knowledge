import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASE16_SLOTS,
  ConfigSchema,
  resolveLeafSchema,
  THEME_ID_PATTERN,
} from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import {
  base16ToTokens,
  buildCustomThemeCss,
  COLOR_THEMES,
  colorThemeWritePatch,
  customThemeKind,
  customThemeWritePatch,
  DEFAULT_CUSTOM_SCHEME,
  defaultThemeTokens,
  generateColorThemesCss,
  hasLegacyCustomSeed,
  isDarkColorTheme,
  isHexColor,
  relativeLuminance,
  resolveColorTheme,
  resolveColorThemeSelection,
  resolveCustomScheme,
} from './color-themes';
import {
  COLOR_THEME_PAIR_STORAGE_KEY,
  COLOR_THEME_STORAGE_KEY,
  CUSTOM_THEME_STYLE_ID,
  SAVED_THEME_STYLE_ID,
} from './use-apply-config-color-theme';

const here = dirname(fileURLToPath(import.meta.url));
const HEX = /^#[0-9a-f]{6}$/;
// Themes whose palette isn't a static, fully-authored scheme: `default` (no
// overlay) and `custom` (built at runtime from the user's scheme).
const NON_STATIC = new Set(['default', 'custom']);

describe('color-themes registry', () => {
  test('default is first; default + custom are the system-kind (non-static) themes', () => {
    expect(COLOR_THEMES[0]?.id).toBe('default');
    expect(COLOR_THEMES[0]?.scheme).toBeUndefined();
    const systemThemes = COLOR_THEMES.filter((t) => t.kind === 'system');
    expect(systemThemes.map((t) => t.id).sort()).toEqual(['custom', 'default']);
  });

  test('every static theme carries all sixteen base16 slots as 6-digit hex', () => {
    for (const theme of COLOR_THEMES) {
      if (NON_STATIC.has(theme.id)) continue;
      // Static built-ins force their own mode — dark or light.
      expect(['dark', 'light']).toContain(theme.kind);
      expect(theme.scheme).toBeDefined();
      const palette = theme.scheme?.palette;
      expect(Object.keys(palette ?? {}).sort()).toEqual([...BASE16_SLOTS].sort());
      for (const slot of BASE16_SLOTS) {
        expect(palette?.[slot], `${theme.id}.${slot}`).toMatch(HEX);
      }
    }
  });

  test("a built-in's kind matches its scheme variant", () => {
    for (const theme of COLOR_THEMES) {
      if (NON_STATIC.has(theme.id)) continue;
      expect(theme.kind, theme.id).toBe(theme.scheme?.variant);
    }
  });

  test('ids are unique', () => {
    const ids = COLOR_THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('resolveColorTheme falls back to default for unknown / missing ids', () => {
    expect(resolveColorTheme(undefined).id).toBe('default');
    expect(resolveColorTheme('not-a-theme').id).toBe('default');
    expect(resolveColorTheme('dracula').id).toBe('dracula');
  });

  test('resolveColorTheme remains safe when a caller supplies a partial live registry', () => {
    expect(resolveColorTheme('dracula', [])).toMatchObject({ id: 'dracula', kind: 'dark' });
    expect(resolveColorTheme('not-a-theme', [])).toMatchObject({ id: 'default', kind: 'system' });
  });

  test('isDarkColorTheme is true for dark IDE themes, false for default and light themes', () => {
    expect(isDarkColorTheme('default')).toBe(false);
    expect(isDarkColorTheme(undefined)).toBe(false);
    expect(isDarkColorTheme('catppuccin-frappe')).toBe(true);
    expect(isDarkColorTheme('catppuccin-latte')).toBe(false);
  });
});

describe('base16ToTokens', () => {
  test('emits every token family a theme is expected to repaint', () => {
    const scheme = COLOR_THEMES[1]?.scheme;
    expect(scheme).toBeDefined();
    const tokens = base16ToTokens(scheme as NonNullable<(typeof COLOR_THEMES)[number]['scheme']>);
    // A representative slice across every family the mapping owns. The
    // callout / lint / ansi entries are the ones a theme previously could not
    // reach at all.
    for (const required of [
      'background',
      'foreground',
      'card',
      'primary',
      'primary-foreground',
      'muted-foreground',
      'destructive',
      'border',
      'ring',
      'selection-soft',
      'sidebar',
      'sidebar-accent-foreground',
      'chart-1',
      'syntax-keyword',
      'syntax-string',
      'syntax-comment',
      'syntax-bg',
      'link-color',
      'lint-error-color',
      'callout-warning-color',
      'callout-quote-color',
      'ansi-red',
      'ansi-bright-white',
    ]) {
      expect(tokens[required], required).toBeTruthy();
    }
  });

  test('every emitted value is a literal — a theme block can carry no var() indirection', () => {
    for (const theme of COLOR_THEMES) {
      if (!theme.scheme) continue;
      for (const [name, value] of Object.entries(base16ToTokens(theme.scheme))) {
        expect(value, `${theme.id} --${name}`).not.toContain('var(');
      }
    }
  });
});

describe('defaultThemeTokens', () => {
  // The tokens a theme preview reads off the token map. `default` has no scheme
  // to map, so these come from the base stylesheet instead — and must be
  // literals, since a preview can't read `var(--…)` out from under an active
  // palette override.
  const SWATCH_TOKENS = [
    'sidebar',
    'background',
    'primary',
    'border',
    'syntax-string',
    'syntax-keyword',
    'syntax-atom',
  ];

  test('resolves every token a swatch reads, with no var() indirection left', () => {
    for (const mode of ['light', 'dark'] as const) {
      const tokens = defaultThemeTokens(mode);
      expect(Object.keys(tokens).sort()).toEqual([...SWATCH_TOKENS].sort());
      for (const [name, value] of Object.entries(tokens)) {
        expect(value, `${mode} ${name}`).toBeTruthy();
        expect(value, `${mode} ${name}`).not.toContain('var(');
      }
    }
  });

  test('light and dark differ on every surface token', () => {
    const light = defaultThemeTokens('light');
    const dark = defaultThemeTokens('dark');
    for (const name of ['sidebar', 'background', 'primary', 'border']) {
      expect(dark[name], name).not.toBe(light[name]);
    }
  });
});

describe('generated stylesheet', () => {
  test('color-themes.generated.css is in sync with the registry (run `pnpm run gen:color-themes`)', () => {
    const onDisk = readFileSync(resolve(here, '../color-themes.generated.css'), 'utf8');
    expect(onDisk).toBe(generateColorThemesCss());
  });

  test('emits one attribute-scoped rule per static IDE theme and none for default/custom', () => {
    const css = generateColorThemesCss();
    expect(css).not.toContain('data-color-theme="default"');
    // `custom` has no static scheme — its rule is built at runtime, not generated.
    expect(css).not.toContain('data-color-theme="custom"');
    for (const theme of COLOR_THEMES) {
      if (NON_STATIC.has(theme.id)) continue;
      expect(css).toContain(`html[data-color-theme="${theme.id}"] {`);
    }
  });
});

describe('registry stays in sync with its consumers', () => {
  test('every appearance palette field admits any grammar-valid id, not a closed set', () => {
    // These fields are shape-constrained strings, not closed enums — that is
    // what lets a saved theme (an id the built-in registry has never heard of)
    // be assigned without failing whole-config validation. The invariant this
    // guards: every built-in id still validates, an id inside the grammar but
    // outside the registry validates, and a string outside the grammar is
    // refused so config and the pre-paint validator stay aligned.
    for (const field of ['colorTheme', 'colorThemeLight', 'colorThemeDark']) {
      for (const id of COLOR_THEMES.map((t) => t.id)) {
        expect(
          ConfigSchema.safeParse({ appearance: { [field]: id } }).success,
          `${field}=${id}`,
        ).toBe(true);
      }
      expect(
        ConfigSchema.safeParse({ appearance: { [field]: 'saved-my-personal-theme' } }).success,
        `${field}=saved id`,
      ).toBe(true);
      for (const bad of ['Not A Theme', 'UPPER', 'has_underscore', 'a'.repeat(33)]) {
        expect(
          ConfigSchema.safeParse({ appearance: { [field]: bad } }).success,
          `${field}=${bad}`,
        ).toBe(false);
      }
    }
  });

  test('the pre-paint FOUC script reads exactly the caches the apply path writes', () => {
    // index.html can't import a module, so its script hardcodes the key names.
    // A rename on either side would silently cost the flash-free first paint.
    const html = readFileSync(resolve(here, '../../index.html'), 'utf8');
    for (const key of [
      COLOR_THEME_PAIR_STORAGE_KEY,
      COLOR_THEME_STORAGE_KEY,
      CUSTOM_THEME_STYLE_ID,
      SAVED_THEME_STYLE_ID,
    ]) {
      expect(html, key).toContain(`'${key}'`);
    }
  });

  test('the pre-paint FOUC script carries no palette-id knowledge', () => {
    // Each cached slot ships its own resolved `dark` flag, so the script never
    // has to know which palettes are light — the enumeration that used to live
    // here (and had to be edited alongside every new theme) is gone. `default`
    // and `custom` are structural cases, not palettes, so they stay.
    const html = readFileSync(resolve(here, '../../index.html'), 'utf8');
    for (const theme of COLOR_THEMES) {
      if (NON_STATIC.has(theme.id)) continue;
      expect(html, theme.id).not.toContain(theme.id);
    }
  });

  test('custom is registered as a tile and accepted by the palette fields', () => {
    expect(COLOR_THEMES.some((t) => t.id === 'custom')).toBe(true);
    expect(ConfigSchema.safeParse({ appearance: { colorTheme: 'custom' } }).success).toBe(true);
  });

  test('the pre-paint FOUC script validates ids with the config fields grammar', () => {
    // index.html can't import a module, so its inline id check hardcodes the
    // grammar. If the two drift, a palette config accepts could fail to
    // pre-paint (flash of unstyled content) — so the inline source must carry
    // THEME_ID_PATTERN verbatim.
    const html = readFileSync(resolve(here, '../../index.html'), 'utf8');
    expect(html).toContain(THEME_ID_PATTERN.source);
  });

  test('every base16 slot is settable under appearance.customTheme', () => {
    for (const slot of BASE16_SLOTS) {
      expect(
        resolveLeafSchema(ConfigSchema, ['appearance', 'customTheme', slot]),
        slot,
      ).toBeDefined();
    }
  });
});

describe('custom theme scheme', () => {
  test('isHexColor accepts #rrggbb only', () => {
    expect(isHexColor('#0f172a')).toBe(true);
    expect(isHexColor('#FFF')).toBe(false);
    expect(isHexColor('0f172a')).toBe(false);
    expect(isHexColor('rebeccapurple')).toBe(false);
    expect(isHexColor(123)).toBe(false);
    expect(isHexColor(undefined)).toBe(false);
  });

  test('relativeLuminance orders black < mid < white', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
    expect(relativeLuminance('#0f172a')).toBeLessThan(0.5);
    expect(relativeLuminance('#f1f5f9')).toBeGreaterThan(0.5);
  });

  test('customThemeKind reports the scheme variant', () => {
    expect(customThemeKind(DEFAULT_CUSTOM_SCHEME)).toBe('dark');
    expect(customThemeKind({ ...DEFAULT_CUSTOM_SCHEME, variant: 'light' })).toBe('light');
  });

  test('resolveCustomScheme returns the full default for an absent value', () => {
    expect(resolveCustomScheme(undefined)).toEqual(DEFAULT_CUSTOM_SCHEME);
  });

  test('resolveCustomScheme merges valid slots over the default and drops bad hex', () => {
    const scheme = resolveCustomScheme({
      base00: '#123456',
      base0D: 'not-a-hex',
      base0B: undefined,
    });
    expect(scheme.palette.base00).toBe('#123456');
    expect(scheme.palette.base0D).toBe(DEFAULT_CUSTOM_SCHEME.palette.base0D);
    expect(scheme.palette.base0B).toBe(DEFAULT_CUSTOM_SCHEME.palette.base0B);
  });

  test('resolveCustomScheme infers variant from the ramp when absent', () => {
    expect(resolveCustomScheme({ base00: '#0a0a0a', base05: '#fafafa' }).variant).toBe('dark');
    expect(resolveCustomScheme({ base00: '#fafafa', base05: '#0a0a0a' }).variant).toBe('light');
  });

  test('resolveCustomScheme honors an explicit variant over the inferred one', () => {
    expect(resolveCustomScheme({ base00: '#0a0a0a', variant: 'light' }).variant).toBe('light');
  });

  test('upgrades a pre-base16 six-color seed instead of discarding it', () => {
    // Config written by an older build carries semantic seed names and no
    // slots; the palette must be reconstructed rather than silently reset.
    const scheme = resolveCustomScheme({
      background: '#101010',
      surface: '#202020',
      foreground: '#fafafa',
      primary: '#3366ff',
      accent: '#33ddcc',
      border: '#303030',
    });
    expect(scheme.palette.base00).toBe('#101010');
    expect(scheme.palette.base01).toBe('#202020');
    expect(scheme.palette.base02).toBe('#303030');
    expect(scheme.palette.base05).toBe('#fafafa');
    // `primary` drove the accent, which is base0D's role.
    expect(scheme.palette.base0D).toBe('#3366ff');
    expect(scheme.variant).toBe('dark');
    for (const slot of BASE16_SLOTS) {
      expect(scheme.palette[slot], slot).toMatch(HEX);
    }
  });

  test('a partial legacy seed merges over the default instead of resetting it', () => {
    // The old editor only wrote the fields a user changed, and configs get
    // hand-edited a field at a time — dropping a partial seed would silently
    // discard a customization.
    const scheme = resolveCustomScheme({ background: '#101010' });
    expect(scheme.palette.base00).toBe('#101010');
    expect(scheme.palette.base0D).toBe(DEFAULT_CUSTOM_SCHEME.palette.base0D);
  });

  test('an object carrying neither slots nor legacy fields yields the default', () => {
    expect(resolveCustomScheme({ unrelated: 'value' })).toEqual(DEFAULT_CUSTOM_SCHEME);
  });

  test('a half-migrated config keeps the legacy palette under the edited slot', () => {
    // The upgrade path a real user walks: they had a custom theme, then nudge
    // one slot in the new editor. If explicit slots layered over the DEFAULT
    // scheme rather than over their upgraded seed, the other fifteen would
    // snap back to slate and their theme would be gone.
    const legacy = {
      background: '#101010',
      surface: '#202020',
      foreground: '#fafafa',
      primary: '#3366ff',
      accent: '#33ddcc',
      border: '#303030',
    };
    const scheme = resolveCustomScheme({ ...legacy, base0D: '#ff0000' });
    expect(scheme.palette.base0D).toBe('#ff0000');
    expect(scheme.palette.base00).toBe('#101010');
    expect(scheme.palette.base01).toBe('#202020');
    expect(scheme.palette.base02).toBe('#303030');
    expect(scheme.palette.base05).toBe('#fafafa');
  });
});

describe('customThemeWritePatch', () => {
  test('writes every slot plus the metadata', () => {
    const patch = customThemeWritePatch(DEFAULT_CUSTOM_SCHEME);
    expect(patch.name).toBe(DEFAULT_CUSTOM_SCHEME.name);
    expect(patch.variant).toBe(DEFAULT_CUSTOM_SCHEME.variant);
    for (const slot of BASE16_SLOTS) {
      expect(patch[slot], slot).toBe(DEFAULT_CUSTOM_SCHEME.palette[slot]);
    }
  });

  test('nulls the pre-base16 seed keys so a patch deletes them', () => {
    // `null` in a config patch is a key deletion. Without this the old six
    // colors linger in config.yml forever as dead, half-format data.
    const patch = customThemeWritePatch(DEFAULT_CUSTOM_SCHEME);
    for (const key of ['background', 'surface', 'foreground', 'primary', 'accent', 'border']) {
      expect(patch[key], key).toBeNull();
    }
  });

  test('the written patch resolves back to the same scheme', () => {
    // Round-trip through the reader: what we persist must reconstruct exactly,
    // including after the legacy keys are gone.
    const patch = customThemeWritePatch(DEFAULT_CUSTOM_SCHEME);
    const persisted = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== null),
    ) as Record<string, unknown>;
    expect(resolveCustomScheme(persisted)).toEqual(DEFAULT_CUSTOM_SCHEME);
  });

  test("carries an imported scheme's author credit through the round-trip", () => {
    // The reader accepts `author`, so a patch that omits it silently drops the
    // credit line of any upstream scheme the user imported.
    const credited = { ...DEFAULT_CUSTOM_SCHEME, author: 'Zeno Rocha' };
    const patch = customThemeWritePatch(credited);
    expect(patch.author).toBe('Zeno Rocha');

    const persisted = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== null),
    ) as Record<string, unknown>;
    expect(resolveCustomScheme(persisted)).toEqual(credited);
  });

  test('nulls author when the scheme has none, so a previous credit is cleared', () => {
    const patch = customThemeWritePatch(DEFAULT_CUSTOM_SCHEME);
    expect(patch.author).toBeNull();
  });
});

describe('hasLegacyCustomSeed', () => {
  test('detects a pre-base16 config and ignores a pure base16 one', () => {
    expect(hasLegacyCustomSeed({ background: '#101010' })).toBe(true);
    expect(hasLegacyCustomSeed({ base00: '#101010' })).toBe(false);
    expect(hasLegacyCustomSeed(undefined)).toBe(false);
    // A non-color value is not a seed to migrate.
    expect(hasLegacyCustomSeed({ background: 'nope' })).toBe(false);
  });

  test('buildCustomThemeCss emits a custom-scoped rule with a matching color-scheme', () => {
    const css = buildCustomThemeCss({
      ...DEFAULT_CUSTOM_SCHEME,
      palette: { ...DEFAULT_CUSTOM_SCHEME.palette, base00: '#0a0a0a' },
    });
    expect(css).toContain('html[data-color-theme="custom"] {');
    expect(css).toContain('color-scheme: dark;');
    expect(css).toContain('--background: #0a0a0a;');

    const lightCss = buildCustomThemeCss({ ...DEFAULT_CUSTOM_SCHEME, variant: 'light' });
    expect(lightCss).toContain('color-scheme: light;');
  });
});

describe('colorThemeWritePatch', () => {
  test('writes both slots and retires the pre-pair key', () => {
    const selection = resolveColorThemeSelection({ colorTheme: 'dracula' });
    expect(colorThemeWritePatch({ ...selection, light: 'catppuccin-latte' })).toEqual({
      colorThemeLight: 'catppuccin-latte',
      colorThemeDark: 'dracula',
      colorTheme: null,
    });
  });

  test('assigning the same palette to both modes is a supported end state', () => {
    const selection = resolveColorThemeSelection({
      colorThemeLight: 'catppuccin-latte',
      colorThemeDark: 'dracula',
    });
    const patch = colorThemeWritePatch({ ...selection, dark: 'catppuccin-latte' });
    expect(patch.colorThemeLight).toBe('catppuccin-latte');
    expect(patch.colorThemeDark).toBe('catppuccin-latte');
  });
});
