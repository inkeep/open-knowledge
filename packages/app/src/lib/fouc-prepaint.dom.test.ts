/**
 * Executes the real pre-paint FOUC script out of `index.html` against seeded
 * localStorage, and asserts the `<html>` state it produces.
 *
 * This is the only coverage of that path. The script cannot import anything —
 * it runs before any bundle — so it reads the cache's field names (`pref`,
 * `light`/`dark`, `.id`, `.dark`) as string literals with no compile-time link
 * to the writer in `use-apply-config-color-theme.ts`. Renaming a field there
 * updates every TypeScript consumer while this script silently reads
 * `undefined` and paints the wrong mode on every reload, with nothing else in
 * the suite going red. Feeding real writer output through the real script is
 * what couples the two.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { ColorThemeSelection } from './color-themes';
import {
  applyColorThemeToDom,
  COLOR_THEME_PAIR_STORAGE_KEY,
  COLOR_THEME_STORAGE_KEY,
  CUSTOM_THEME_STORAGE_KEY,
  CUSTOM_THEME_STYLE_ID,
} from './use-apply-config-color-theme';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The theme pre-paint script, lifted verbatim from `index.html`. Identified by
 * the cache key it reads rather than by position, so an added `<script>` can't
 * silently shift which one is under test.
 */
function prePaintScript(): string {
  const html = readFileSync(resolve(here, '../../index.html'), 'utf8');
  const body = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .find((s) => s.includes(COLOR_THEME_PAIR_STORAGE_KEY));
  if (!body) throw new Error('pre-paint theme script not found in index.html');
  return body;
}

let script: string;

beforeAll(() => {
  if (typeof localStorage === 'undefined') {
    (globalThis as { localStorage?: Storage }).localStorage = window.localStorage;
  }
  script = prePaintScript();
});

/** Run the pre-paint script against the current DOM + localStorage. */
function runPrePaint(prefersDark: boolean): void {
  window.matchMedia = ((query: string) =>
    ({
      matches: prefersDark && query.includes('dark'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      onchange: null,
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
  new Function(script)();
}

function reset(): void {
  document.documentElement.className = '';
  document.documentElement.removeAttribute('data-color-theme');
  document.getElementById(CUSTOM_THEME_STYLE_ID)?.remove();
  localStorage.clear();
}

/** Seed the caches exactly as the app writes them — no hand-built JSON. */
function seed(
  selection: ColorThemeSelection,
  modePreference: 'light' | 'dark' | 'system',
  slotMode: 'light' | 'dark',
  customSeed?: Record<string, unknown>,
): void {
  applyColorThemeToDom({ selection, modePreference, slotMode, customSeed });
  // Only the caches survive a reload; the live DOM does not.
  document.documentElement.className = '';
  document.documentElement.removeAttribute('data-color-theme');
  document.getElementById(CUSTOM_THEME_STYLE_ID)?.remove();
}

const state = () => ({
  attr: document.documentElement.getAttribute('data-color-theme'),
  dark: document.documentElement.classList.contains('dark'),
});

describe('pre-paint FOUC script', () => {
  beforeEach(reset);

  test('reads the writer’s own cache — the field-name contract holds end to end', () => {
    seed({ light: 'catppuccin-latte', dark: 'dracula' }, 'system', 'dark');
    runPrePaint(true);
    expect(state()).toEqual({ attr: 'dracula', dark: true });
  });

  test('follows the OS for a system preference, picking the other slot', () => {
    seed({ light: 'catppuccin-latte', dark: 'dracula' }, 'system', 'dark');
    runPrePaint(false);
    // The cache was written while dark was on screen, but the OS is light now:
    // the light slot must win, which is the whole point of caching both.
    expect(state()).toEqual({ attr: 'catppuccin-latte', dark: false });
  });

  test('an explicit preference ignores the OS', () => {
    seed({ light: 'catppuccin-latte', dark: 'dracula' }, 'light', 'light');
    runPrePaint(true);
    expect(state()).toEqual({ attr: 'catppuccin-latte', dark: false });
  });

  test('a cross-variant palette paints its own variant, not the slot’s', () => {
    // Dracula assigned to the light slot still forces dark, so `dark:` variants
    // resolve against the tokens actually on screen.
    seed({ light: 'dracula', dark: 'dracula' }, 'light', 'light');
    runPrePaint(false);
    expect(state()).toEqual({ attr: 'dracula', dark: true });
  });

  test('a default slot sets no attribute and takes the slot’s own mode', () => {
    seed({ light: 'default', dark: 'dracula' }, 'system', 'dark');
    runPrePaint(false);
    expect(state()).toEqual({ attr: null, dark: false });
  });

  test('replays the custom stylesheet and its variant', () => {
    seed({ light: 'catppuccin-latte', dark: 'custom' }, 'dark', 'dark', {
      base00: '#0a0a0a',
      base05: '#eeeeee',
    });
    runPrePaint(true);
    expect(state()).toEqual({ attr: 'custom', dark: true });
    expect(document.getElementById(CUSTOM_THEME_STYLE_ID)?.textContent).toContain(
      '--background: #0a0a0a;',
    );
  });

  test('falls back to the pre-pair single-palette cache exactly once', () => {
    // Written by a build that predates the pair; `ok-theme-v1` already carried
    // the mode that palette forced.
    localStorage.setItem(COLOR_THEME_STORAGE_KEY, 'monokai');
    localStorage.setItem('ok-theme-v1', 'dark');
    runPrePaint(false);
    expect(state()).toEqual({ attr: 'monokai', dark: true });
  });

  test('legacy fallback with no mode cache leaves the dark class to the OS', () => {
    // Pins a bounded limitation rather than a desirable behavior: the legacy
    // branch has no palette-to-variant table (removing it is the point), so it
    // leans on `ok-theme-v1` carrying the mode the old build's palette forced.
    // With that key gone, a dark palette on a light OS paints dark tokens
    // without the dark class. It survives one pre-paint at most, because the
    // app rewrites the pair cache on mount.
    localStorage.setItem(COLOR_THEME_STORAGE_KEY, 'monokai');
    runPrePaint(false);
    expect(state()).toEqual({ attr: 'monokai', dark: false });
  });

  test('a custom slot with no CSS cache applies no palette at all', () => {
    // Storage eviction can drop the stylesheet while the pair survives.
    // Setting `data-color-theme="custom"` with no matching rule would paint an
    // unstyled frame, so the script drops the palette instead.
    seed({ light: 'default', dark: 'custom' }, 'dark', 'dark', { base00: '#0a0a0a' });
    localStorage.removeItem(CUSTOM_THEME_STORAGE_KEY);
    runPrePaint(true);
    expect(state()).toEqual({ attr: null, dark: true });
    expect(document.getElementById(CUSTOM_THEME_STYLE_ID)).toBeNull();
  });

  test('the pair wins over a stale pre-pair key', () => {
    seed({ light: 'catppuccin-latte', dark: 'dracula' }, 'light', 'light');
    localStorage.setItem(COLOR_THEME_STORAGE_KEY, 'monokai');
    runPrePaint(false);
    expect(state()).toEqual({ attr: 'catppuccin-latte', dark: false });
  });

  test('no cache at all paints the base theme in the OS mode', () => {
    runPrePaint(true);
    expect(state()).toEqual({ attr: null, dark: true });
  });

  test('survives corrupt cache JSON without throwing or painting a palette', () => {
    localStorage.setItem(COLOR_THEME_PAIR_STORAGE_KEY, '{not json');
    localStorage.setItem(CUSTOM_THEME_STORAGE_KEY, '{also not json');
    expect(() => runPrePaint(false)).not.toThrow();
    expect(state()).toEqual({ attr: null, dark: false });
  });
});
