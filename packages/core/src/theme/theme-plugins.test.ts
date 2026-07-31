import { describe, expect, test } from 'vitest';
import { BASE16_SLOTS, base16ToTokens } from './base16.ts';
import {
  colorThemeMode,
  generateColorThemesCss,
  isDarkTheme,
  renderThemeBlock,
  resolveThemePlugin,
  THEME_PLUGIN_IDS,
  THEME_PLUGINS,
} from './theme-plugins.ts';

// Themes without a static, fully-authored scheme: `default` (no overlay) and
// `custom` (built at runtime from the user's scheme).
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
      // Every static built-in forces the mode its scheme declares.
      expect(['dark', 'light']).toContain(theme.kind);
      expect(theme.kind, theme.id).toBe(theme.scheme?.variant);
      expect(theme.scheme).toBeDefined();
      // The descriptor owns its behavior (the analog of LintPlugin.lint).
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
});

describe('config enum derives from the registry', () => {
  // The headline of the plugin refactor: the `appearance.colorTheme` enum is
  // built from THEME_PLUGIN_IDS, which is built from the registry. Adding a
  // ThemePlugin grows the enum with no schema edit — the coupling the old
  // hand-listed enum carried is gone. (The schema-level cross-check that the
  // ConfigSchema enum equals these ids lives in the app's color-themes.test.ts.)
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
    // system-kind themes (default/custom) and unknown ids defer to appearance.theme.
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
