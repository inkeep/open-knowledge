import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigSchema, resolveLeafSchema } from '@inkeep/open-knowledge-core';
import { getEnumOptions } from '../components/settings/schema-walker';
import {
  buildCustomThemeCss,
  COLOR_THEMES,
  type ColorThemeBase,
  type CustomThemeSeed,
  customThemeKind,
  DEFAULT_CUSTOM_SEED,
  expandCustomSeed,
  expandPalette,
  generateColorThemesCss,
  isDarkColorTheme,
  isHexColor,
  relativeLuminance,
  resolveColorTheme,
  resolveCustomSeed,
} from './color-themes';

const HEX = /^#[0-9a-f]{6}$/;
// Themes whose palette isn't a static, fully-authored `base`: `default` (no
// overlay) and `custom` (built at runtime from the user seed).
const NON_STATIC = new Set(['default', 'custom']);

describe('color-themes registry', () => {
  test('default is first; default + custom are the system-kind (non-static) themes', () => {
    expect(COLOR_THEMES[0]?.id).toBe('default');
    expect(COLOR_THEMES[0]?.base).toBeUndefined();
    const systemThemes = COLOR_THEMES.filter((t) => t.kind === 'system');
    expect(systemThemes.map((t) => t.id).sort()).toEqual(['custom', 'default']);
  });

  test('every static theme carries a full base palette of 6-digit hex colors', () => {
    for (const theme of COLOR_THEMES) {
      if (NON_STATIC.has(theme.id)) continue;
      // Static built-ins force their own mode — dark or light.
      expect(['dark', 'light']).toContain(theme.kind);
      expect(theme.base).toBeDefined();
      for (const [key, value] of Object.entries(theme.base as ColorThemeBase)) {
        expect(value, `${theme.id}.${key}`).toMatch(HEX);
      }
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

  test('isDarkColorTheme is true for dark IDE themes, false for default and light themes', () => {
    expect(isDarkColorTheme('default')).toBe(false);
    expect(isDarkColorTheme(undefined)).toBe(false);
    expect(isDarkColorTheme('catppuccin-frappe')).toBe(true);
    expect(isDarkColorTheme('catppuccin-latte')).toBe(false);
  });
});

describe('expandPalette', () => {
  test('emits every shadcn surface token the base .dark block defines', () => {
    const tokens = expandPalette(COLOR_THEMES[1]?.base as ColorThemeBase);
    // A representative slice across surface, accent, sidebar, and syntax families.
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
      'sidebar',
      'sidebar-accent-foreground',
      'chart-1',
      'syntax-keyword',
      'syntax-string',
    ]) {
      expect(tokens[required], required).toBeTruthy();
    }
  });
});

describe('generated stylesheet', () => {
  test('color-themes.generated.css is in sync with the registry (run `bun run gen:color-themes`)', () => {
    const onDisk = readFileSync(resolve(import.meta.dir, '../color-themes.generated.css'), 'utf8');
    expect(onDisk).toBe(generateColorThemesCss());
  });

  test('emits one attribute-scoped rule per static IDE theme and none for default/custom', () => {
    const css = generateColorThemesCss();
    expect(css).not.toContain('data-color-theme="default"');
    // `custom` has no static base — its rule is built at runtime, not generated.
    expect(css).not.toContain('data-color-theme="custom"');
    for (const theme of COLOR_THEMES) {
      if (NON_STATIC.has(theme.id)) continue;
      expect(css).toContain(`html[data-color-theme="${theme.id}"] {`);
    }
  });
});

describe('registry stays in sync with its consumers', () => {
  test('ids match the appearance.colorTheme enum in ConfigSchema', () => {
    const leaf = resolveLeafSchema(ConfigSchema, ['appearance', 'colorTheme']);
    const enumOptions = leaf ? getEnumOptions(leaf) : undefined;
    expect([...(enumOptions ?? [])].sort()).toEqual(COLOR_THEMES.map((t) => t.id).sort());
  });

  test('every static IDE id appears in the index.html FOUC allowlist', () => {
    // The pre-paint script in index.html can't import this module, so it
    // hardcodes the id allowlist. `default` (no overlay) and `custom` (replayed
    // from a cached <style>, not the static allowlist) are handled separately.
    const html = readFileSync(resolve(import.meta.dir, '../../index.html'), 'utf8');
    for (const theme of COLOR_THEMES) {
      if (theme.id === 'default' || theme.id === 'custom') continue;
      expect(html, theme.id).toContain(`'${theme.id}'`);
    }
  });

  test('the index.html FOUC light-theme set matches the registry light themes', () => {
    // The pre-paint script decides the `dark` class before any bundle loads, so
    // it can't import the registry — it carries its own light-id array
    // (`[...].includes(ct)`). Adding a light theme must update that array too, or
    // the new theme would flash dark on first paint. This asserts the two stay in
    // lockstep (the light-kind analog of the allowlist-presence check above).
    const html = readFileSync(resolve(import.meta.dir, '../../index.html'), 'utf8');
    const match = html.match(/\[([^\]]*)\]\.includes\(ct\)/);
    expect(match, 'FOUC light-theme array (`[...].includes(ct)`) not found in index.html').not.toBe(
      null,
    );
    const scriptLightIds = [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    const registryLightIds = COLOR_THEMES.filter((t) => t.kind === 'light')
      .map((t) => t.id)
      .sort();
    expect(scriptLightIds).toEqual(registryLightIds);
  });

  test('custom is registered as a tile and accepted by the schema enum', () => {
    expect(COLOR_THEMES.some((t) => t.id === 'custom')).toBe(true);
    const leaf = resolveLeafSchema(ConfigSchema, ['appearance', 'colorTheme']);
    expect([...(leaf ? (getEnumOptions(leaf) ?? []) : [])]).toContain('custom');
  });
});

describe('custom theme seed', () => {
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

  test('customThemeKind derives mode from the background luminance', () => {
    expect(customThemeKind({ ...DEFAULT_CUSTOM_SEED, background: '#0f172a' })).toBe('dark');
    expect(customThemeKind({ ...DEFAULT_CUSTOM_SEED, background: '#fefefe' })).toBe('light');
  });

  test('resolveCustomSeed merges valid fields over the default and drops bad hex', () => {
    const seed = resolveCustomSeed({
      background: '#123456',
      primary: 'not-a-hex',
      accent: undefined,
    });
    expect(seed.background).toBe('#123456');
    expect(seed.primary).toBe(DEFAULT_CUSTOM_SEED.primary);
    expect(seed.accent).toBe(DEFAULT_CUSTOM_SEED.accent);
  });

  test('resolveCustomSeed returns the full default for an absent seed', () => {
    expect(resolveCustomSeed(undefined)).toEqual(DEFAULT_CUSTOM_SEED);
  });

  test('expandCustomSeed maps the six seeds onto the base palette', () => {
    const seed: CustomThemeSeed = {
      background: '#101010',
      surface: '#202020',
      foreground: '#fafafa',
      primary: '#3366ff',
      accent: '#33ddcc',
      border: '#303030',
    };
    const base = expandCustomSeed(seed);
    expect(base.bg).toBe('#101010');
    expect(base.bgElevated).toBe('#202020');
    expect(base.fg).toBe('#fafafa');
    expect(base.primary).toBe('#3366ff');
    expect(base.blue).toBe('#33ddcc');
    // Text on a dark primary is white; muted text is a derived color-mix.
    expect(base.primaryFg).toBe('#ffffff');
    expect(base.fgMuted).toContain('color-mix');
  });

  test('buildCustomThemeCss emits a custom-scoped rule with the seed + matching color-scheme', () => {
    const css = buildCustomThemeCss({ ...DEFAULT_CUSTOM_SEED, background: '#0a0a0a' });
    expect(css).toContain('html[data-color-theme="custom"] {');
    expect(css).toContain('color-scheme: dark;');
    expect(css).toContain('--background: #0a0a0a;');

    const lightCss = buildCustomThemeCss({ ...DEFAULT_CUSTOM_SEED, background: '#fafafa' });
    expect(lightCss).toContain('color-scheme: light;');
  });
});
