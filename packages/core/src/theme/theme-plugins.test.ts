import { describe, expect, test } from 'vitest';
import { BASE16_SLOTS, base16ToTokens } from './base16.ts';
import {
  colorThemeMode,
  deriveSavedThemeId,
  deriveSavedThemeName,
  generateColorThemesCss,
  isDarkTheme,
  parseSavedThemeId,
  renderThemeBlock,
  resolveColorThemeSelection,
  resolveModePreference,
  resolveThemePlugin,
  SAVED_THEME_ID_PREFIX,
  THEME_ID_PATTERN,
  THEME_PLUGIN_IDS,
  THEME_PLUGINS,
} from './theme-plugins.ts';

const NON_STATIC = new Set(['default', 'custom']);

describe('THEME_PLUGINS registry', () => {
  test('default is first; default + custom are the system-kind (non-static) themes', () => {
    expect(THEME_PLUGINS[0]?.id).toBe('default');
    expect(THEME_PLUGINS[0]?.scheme).toBeUndefined();
    const systemThemes = THEME_PLUGINS.filter((t) => t.kind === 'system');
    expect(systemThemes.map((t) => t.id).sort()).toEqual(['custom', 'default']);
  });

  test('every static theme carries a full base16 scheme + a toTokens behavior', () => {
    for (const theme of THEME_PLUGINS) {
      if (NON_STATIC.has(theme.id)) continue;
      expect(['dark', 'light']).toContain(theme.kind);
      expect(theme.kind, theme.id).toBe(theme.scheme?.variant);
      expect(theme.scheme).toBeDefined();
      expect(typeof theme.toTokens).toBe('function');
      const palette = theme.scheme?.palette;
      expect(Object.keys(palette ?? {}).sort()).toEqual([...BASE16_SLOTS].sort());
      for (const slot of BASE16_SLOTS) {
        expect(palette?.[slot], `${theme.id}.${slot}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  test('ids are unique', () => {
    const ids = THEME_PLUGINS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('no built-in id begins with the reserved saved-theme prefix', () => {
    for (const theme of THEME_PLUGINS) {
      expect(theme.id.startsWith(SAVED_THEME_ID_PREFIX), theme.id).toBe(false);
    }
  });
});

describe('deriveSavedThemeName', () => {
  test('keeps the display name and derives a natural id from punctuation and spaces', () => {
    expect(deriveSavedThemeName("  John's theme  ")).toEqual({
      ok: true,
      name: "John's theme",
      stem: 'johns-theme',
      id: 'saved-johns-theme',
    });
    expect(deriveSavedThemeName('John’s theme')).toMatchObject({
      ok: true,
      stem: 'johns-theme',
      id: 'saved-johns-theme',
    });
  });

  test('folds Latin diacritics into an ASCII filename id', () => {
    expect(deriveSavedThemeName('Café Noir')).toEqual({
      ok: true,
      name: 'Café Noir',
      stem: 'cafe-noir',
      id: 'saved-cafe-noir',
    });
  });

  test('gives non-ASCII and overlong names stable ids within the grammar', () => {
    const nonAscii = deriveSavedThemeName('夜空 🌙');
    const overlong = deriveSavedThemeName('This is a particularly long custom theme name');
    expect(nonAscii).toMatchObject({ ok: true, name: '夜空 🌙' });
    expect(overlong).toMatchObject({
      ok: true,
      name: 'This is a particularly long custom theme name',
    });
    if (nonAscii.ok) expect(THEME_ID_PATTERN.test(nonAscii.id)).toBe(true);
    if (overlong.ok) expect(THEME_ID_PATTERN.test(overlong.id)).toBe(true);
    expect(deriveSavedThemeName('夜空 🌙')).toEqual(nonAscii);
    expect(deriveSavedThemeName('This is a particularly long custom theme name')).toEqual(overlong);
  });

  test('refuses only an empty display name', () => {
    expect(deriveSavedThemeName('   ')).toEqual({ ok: false, code: 'empty' });
  });
});

describe('deriveSavedThemeId', () => {
  test('prefixes the stem and stays inside the theme-id grammar', () => {
    const result = deriveSavedThemeId('midnight');
    expect(result).toEqual({ ok: true, id: 'saved-midnight' });
    if (result.ok) expect(THEME_ID_PATTERN.test(result.id)).toBe(true);
  });

  test('refuses an over-length stem with a distinct code rather than truncating', () => {
    const stem = 'a'.repeat(27);
    expect(deriveSavedThemeId(stem)).toEqual({ ok: false, code: 'too-long' });
    expect(deriveSavedThemeId('a'.repeat(26))).toEqual({ ok: true, id: `saved-${'a'.repeat(26)}` });
  });

  test('refuses characters outside the grammar rather than rewriting them', () => {
    for (const stem of ['My Theme', 'café', 'sub/dir', 'UPPER']) {
      expect(deriveSavedThemeId(stem)).toEqual({ ok: false, code: 'invalid-chars' });
    }
  });

  test('refuses an empty stem', () => {
    expect(deriveSavedThemeId('')).toEqual({ ok: false, code: 'empty' });
  });

  test('a stem that already carries the prefix doubles it, unambiguously', () => {
    expect(deriveSavedThemeId('saved-theme')).toEqual({ ok: true, id: 'saved-saved-theme' });
  });
});

describe('parseSavedThemeId', () => {
  test('recovers the stem from a well-formed saved-theme id (round-trips deriveSavedThemeId)', () => {
    for (const stem of ['midnight', 'a', 'my-theme', 'saved-theme', 'a'.repeat(26)]) {
      const derived = deriveSavedThemeId(stem);
      expect(derived.ok).toBe(true);
      if (derived.ok) expect(parseSavedThemeId(derived.id)).toEqual({ ok: true, stem });
    }
  });

  test('refuses a built-in id (no reserved prefix)', () => {
    for (const id of ['dracula', 'default', 'custom', 'catppuccin-latte']) {
      expect(parseSavedThemeId(id)).toEqual({ ok: false });
    }
  });

  test('refuses a bare prefix with an empty stem', () => {
    expect(parseSavedThemeId('saved-')).toEqual({ ok: false });
  });

  test('refuses an id outside the grammar', () => {
    for (const id of ['saved-My Theme', 'saved-sub/dir', '', `saved-${'a'.repeat(27)}`]) {
      expect(parseSavedThemeId(id)).toEqual({ ok: false });
    }
  });
});

describe('built-in id list derives from the registry', () => {
  test('THEME_PLUGIN_IDS is exactly the registry ids, in order', () => {
    expect([...THEME_PLUGIN_IDS]).toEqual(THEME_PLUGINS.map((t) => t.id));
  });
});

describe('resolveThemePlugin / isDarkTheme', () => {
  test('resolveThemePlugin falls back to default for unknown / missing ids', () => {
    expect(resolveThemePlugin(undefined).id).toBe('default');
    expect(resolveThemePlugin('not-a-theme').id).toBe('default');
    expect(resolveThemePlugin('dracula').id).toBe('dracula');
  });

  test('isDarkTheme is true for dark palettes, false for default and light palettes', () => {
    expect(isDarkTheme('default')).toBe(false);
    expect(isDarkTheme(undefined)).toBe(false);
    expect(isDarkTheme('catppuccin-frappe')).toBe(true);
    expect(isDarkTheme('catppuccin-latte')).toBe(false);
  });

  test('colorThemeMode forces a palette mode and defers for system themes', () => {
    expect(colorThemeMode('catppuccin-frappe')).toBe('dark');
    expect(colorThemeMode('catppuccin-latte')).toBe('light');
    expect(colorThemeMode('default')).toBeUndefined();
    expect(colorThemeMode('custom')).toBeUndefined();
    expect(colorThemeMode(undefined)).toBeUndefined();
  });
});

describe('token mapping + generateColorThemesCss', () => {
  test("a descriptor's toTokens matches mapping its scheme directly", () => {
    for (const theme of THEME_PLUGINS) {
      if (!theme.scheme || !theme.toTokens) continue;
      expect(theme.toTokens(), theme.id).toEqual(base16ToTokens(theme.scheme));
    }
  });

  test('renderThemeBlock emits the selector, color-scheme, and every token', () => {
    const block = renderThemeBlock('html[data-color-theme="x"]', 'light', {
      background: '#ffffff',
      'syntax-keyword': '#112233',
    });
    expect(block).toContain('html[data-color-theme="x"] {');
    expect(block).toContain('color-scheme: light;');
    expect(block).toContain('--background: #ffffff;');
    expect(block).toContain('--syntax-keyword: #112233;');
  });

  test('generated CSS emits one attribute rule per dark theme; none for default/custom', () => {
    const css = generateColorThemesCss();
    expect(css).not.toContain('data-color-theme="default"');
    expect(css).not.toContain('data-color-theme="custom"');
    for (const theme of THEME_PLUGINS) {
      if (NON_STATIC.has(theme.id)) continue;
      expect(css).toContain(`html[data-color-theme="${theme.id}"] {`);
    }
  });
});

describe('resolveColorThemeSelection', () => {
  test('reads the light/dark pair when set', () => {
    expect(
      resolveColorThemeSelection({
        colorThemeLight: 'catppuccin-latte',
        colorThemeDark: 'dracula',
      }),
    ).toEqual({ light: 'catppuccin-latte', dark: 'dracula' });
  });

  test('reads saved ids when the caller supplies the live palette registry', () => {
    const themes = [
      ...THEME_PLUGINS,
      { id: 'saved-day', label: 'Day', kind: 'light' as const },
      { id: 'saved-night', label: 'Night', kind: 'dark' as const },
    ];

    expect(
      resolveColorThemeSelection(
        { colorThemeLight: 'saved-day', colorThemeDark: 'saved-night' },
        themes,
      ),
    ).toEqual({ light: 'saved-day', dark: 'saved-night' });
  });

  test('a legacy single palette seeds both slots, so the pre-pair config renders unchanged', () => {
    expect(resolveColorThemeSelection({ colorTheme: 'dracula' })).toEqual({
      light: 'dracula',
      dark: 'dracula',
    });
  });

  test('a half-written pair falls back to the legacy palette per slot, not to default', () => {
    expect(
      resolveColorThemeSelection({ colorTheme: 'monokai', colorThemeDark: 'gruvbox' }),
    ).toEqual({ light: 'monokai', dark: 'gruvbox' });
  });

  test('an explicit unknown slot falls back to default without reviving the legacy palette', () => {
    expect(
      resolveColorThemeSelection({
        colorTheme: 'monokai',
        colorThemeLight: 'missing-theme',
      }),
    ).toEqual({ light: 'default', dark: 'monokai' });
  });

  test('an empty or unknown selection resolves to default in both slots', () => {
    expect(resolveColorThemeSelection(undefined)).toEqual({ light: 'default', dark: 'default' });
    expect(resolveColorThemeSelection({})).toEqual({ light: 'default', dark: 'default' });
    expect(
      resolveColorThemeSelection({ colorTheme: 'nope', colorThemeLight: 'also-nope' }),
    ).toEqual({ light: 'default', dark: 'default' });
  });

  test('any palette is admissible in either slot', () => {
    expect(
      resolveColorThemeSelection({
        colorThemeLight: 'dracula',
        colorThemeDark: 'catppuccin-latte',
      }),
    ).toEqual({ light: 'dracula', dark: 'catppuccin-latte' });
  });
});

describe('resolveModePreference', () => {
  test('an explicit preference ignores the OS', () => {
    expect(resolveModePreference('light', true)).toBe('light');
    expect(resolveModePreference('dark', false)).toBe('dark');
  });

  test("'system', an absent value, and junk all follow the OS", () => {
    expect(resolveModePreference('system', true)).toBe('dark');
    expect(resolveModePreference('system', false)).toBe('light');
    expect(resolveModePreference(undefined, true)).toBe('dark');
    expect(resolveModePreference('nope', false)).toBe('light');
  });
});
