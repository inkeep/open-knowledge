import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import {
  COLOR_THEMES,
  type ColorTheme,
  type ColorThemeSelection,
  DEFAULT_CUSTOM_SCHEME,
} from './color-themes';
import {
  type ApplyColorThemeInput,
  applyColorThemeToDom,
  COLOR_THEME_ATTRIBUTE,
  COLOR_THEME_PAIR_STORAGE_KEY,
  COLOR_THEME_STORAGE_KEY,
  CUSTOM_THEME_STORAGE_KEY,
  CUSTOM_THEME_STYLE_ID,
  SAVED_THEME_STYLE_ID,
  useApplyConfigColorTheme,
} from './use-apply-config-color-theme';

beforeAll(() => {
  if (typeof localStorage === 'undefined') {
    (globalThis as { localStorage?: Storage }).localStorage = window.localStorage;
  }
});

function both(id: ColorThemeSelection['light']): ColorThemeSelection {
  return { light: id, dark: id };
}

function apply(input: Partial<ApplyColorThemeInput> & { selection: ColorThemeSelection }): void {
  applyColorThemeToDom({ modePreference: 'dark', slotMode: 'dark', ...input });
}

function readSelectionCache(): {
  pref?: string;
  light?: { id: string; dark: boolean; css?: string };
  dark?: { id: string; dark: boolean; css?: string };
} {
  return JSON.parse(localStorage.getItem(COLOR_THEME_PAIR_STORAGE_KEY) ?? '{}');
}

function Harness({
  selection,
  slotMode = 'dark',
  enabled,
  themes,
  ready,
}: {
  selection: ColorThemeSelection;
  slotMode?: 'light' | 'dark';
  enabled?: boolean;
  themes?: readonly ColorTheme[];
  ready?: boolean;
}) {
  useApplyConfigColorTheme({
    selection,
    modePreference: slotMode,
    slotMode,
    enabled: enabled ?? true,
    themes,
    ready,
  });
  return null;
}

function CustomHarness({ enabled }: { enabled: boolean }) {
  useApplyConfigColorTheme({
    selection: both('custom'),
    modePreference: 'dark',
    slotMode: 'dark',
    customSeed: { background: '#101014' },
    enabled,
  });
  return null;
}

function resetDom(): void {
  document.documentElement.removeAttribute(COLOR_THEME_ATTRIBUTE);
  document.getElementById(CUSTOM_THEME_STYLE_ID)?.remove();
  document.getElementById(SAVED_THEME_STYLE_ID)?.remove();
  try {
    localStorage.removeItem(COLOR_THEME_PAIR_STORAGE_KEY);
    localStorage.removeItem(COLOR_THEME_STORAGE_KEY);
    localStorage.removeItem(CUSTOM_THEME_STORAGE_KEY);
  } catch {}
}

describe('useApplyConfigColorTheme', () => {
  afterEach(() => {
    cleanup();
    resetDom();
  });

  test('applies the palette assigned to the mode on screen', () => {
    render(<Harness selection={{ light: 'catppuccin-latte', dark: 'dracula' }} slotMode="dark" />);
    expect(document.documentElement.getAttribute(COLOR_THEME_ATTRIBUTE)).toBe('dracula');
  });

  test('an OS-driven mode flip swaps the palette with no config change', () => {
    const selection: ColorThemeSelection = { light: 'catppuccin-latte', dark: 'dracula' };
    const { rerender } = render(<Harness selection={selection} slotMode="dark" />);
    expect(document.documentElement.getAttribute(COLOR_THEME_ATTRIBUTE)).toBe('dracula');
    rerender(<Harness selection={selection} slotMode="light" />);
    expect(document.documentElement.getAttribute(COLOR_THEME_ATTRIBUTE)).toBe('catppuccin-latte');
  });

  test('an OS-driven mode flip applies each saved palette assigned to its slot', () => {
    const themes: readonly ColorTheme[] = [
      ...COLOR_THEMES,
      {
        id: 'saved-day',
        label: 'Day',
        kind: 'light',
        scheme: {
          ...DEFAULT_CUSTOM_SCHEME,
          name: 'Day',
          variant: 'light',
          palette: { ...DEFAULT_CUSTOM_SCHEME.palette, base00: '#fafafa' },
        },
      },
      {
        id: 'saved-night',
        label: 'Night',
        kind: 'dark',
        scheme: {
          ...DEFAULT_CUSTOM_SCHEME,
          name: 'Night',
          palette: { ...DEFAULT_CUSTOM_SCHEME.palette, base00: '#08090a' },
        },
      },
    ];
    const selection: ColorThemeSelection = { light: 'saved-day', dark: 'saved-night' };

    const { rerender } = render(<Harness selection={selection} slotMode="light" themes={themes} />);
    expect(document.documentElement.getAttribute(COLOR_THEME_ATTRIBUTE)).toBe('saved-day');
    expect(document.head.textContent).toContain('--background: #fafafa;');
    expect(readSelectionCache().light?.css).toContain('--background: #fafafa;');
    expect(readSelectionCache().dark?.css).toContain('--background: #08090a;');

    rerender(<Harness selection={selection} slotMode="dark" themes={themes} />);
    expect(document.documentElement.getAttribute(COLOR_THEME_ATTRIBUTE)).toBe('saved-night');
    expect(document.head.textContent).toContain('--background: #08090a;');
    expect(document.head.textContent).not.toContain('--background: #fafafa;');
  });

  test('caches BOTH slots, so a reload landing in the other mode still pre-paints', () => {
    render(<Harness selection={{ light: 'catppuccin-latte', dark: 'dracula' }} slotMode="dark" />);
    const cached = readSelectionCache();
    expect(cached.light).toEqual({ id: 'catppuccin-latte', dark: false });
    expect(cached.dark).toEqual({ id: 'dracula', dark: true });
  });

  test("caches the mode preference, not next-themes' possibly-forced value", () => {
    render(
      <Harness
        selection={{ light: 'catppuccin-latte', dark: 'dracula' }}
        slotMode="dark"
        enabled
      />,
    );
    expect(readSelectionCache().pref).toBe('dark');
  });

  test('clears the attribute + cache when both slots are back to default', () => {
    const { rerender } = render(<Harness selection={both('catppuccin-frappe')} />);
    expect(document.documentElement.getAttribute(COLOR_THEME_ATTRIBUTE)).toBe('catppuccin-frappe');
    rerender(<Harness selection={both('default')} />);
    expect(document.documentElement.hasAttribute(COLOR_THEME_ATTRIBUTE)).toBe(false);
    expect(localStorage.getItem(COLOR_THEME_PAIR_STORAGE_KEY)).toBeNull();
  });

  test('keeps the cache when only the OTHER slot carries a palette', () => {
    render(<Harness selection={{ light: 'default', dark: 'dracula' }} slotMode="light" />);
    expect(document.documentElement.hasAttribute(COLOR_THEME_ATTRIBUTE)).toBe(false);
    expect(readSelectionCache().dark).toEqual({ id: 'dracula', dark: true });
  });

  test('a dark palette assigned to light mode still paints dark', () => {
    render(<Harness selection={{ light: 'dracula', dark: 'dracula' }} slotMode="light" />);
    expect(readSelectionCache().light).toEqual({ id: 'dracula', dark: true });
  });

  test('treats an unknown id as default (clears the overlay)', () => {
    render(<Harness selection={both('not-a-real-theme' as ColorThemeSelection['light'])} />);
    expect(document.documentElement.hasAttribute(COLOR_THEME_ATTRIBUTE)).toBe(false);
  });

  test('preserves the prepaint palette until startup config and saved themes are ready', () => {
    document.documentElement.setAttribute(COLOR_THEME_ATTRIBUTE, 'saved-prepaint');
    const style = document.createElement('style');
    style.id = SAVED_THEME_STYLE_ID;
    style.textContent = 'html[data-color-theme="saved-prepaint"] { --background: #123456; }';
    document.head.appendChild(style);

    render(
      <Harness
        selection={both('saved-prepaint' as ColorThemeSelection['light'])}
        themes={COLOR_THEMES}
        ready={false}
      />,
    );

    expect(document.documentElement.getAttribute(COLOR_THEME_ATTRIBUTE)).toBe('saved-prepaint');
    expect(document.getElementById(SAVED_THEME_STYLE_ID)?.textContent).toContain(
      '--background: #123456;',
    );
  });
});

describe('useApplyConfigColorTheme — Themes plugin disabled', () => {
  afterEach(() => {
    cleanup();
    resetDom();
  });

  test('disabling reverts an active named palette to the default', () => {
    const { rerender } = render(<Harness selection={both('catppuccin-frappe')} enabled />);
    expect(document.documentElement.getAttribute(COLOR_THEME_ATTRIBUTE)).toBe('catppuccin-frappe');

    rerender(<Harness selection={both('catppuccin-frappe')} enabled={false} />);
    expect(document.documentElement.hasAttribute(COLOR_THEME_ATTRIBUTE)).toBe(false);
    expect(localStorage.getItem(COLOR_THEME_PAIR_STORAGE_KEY)).toBeNull();
  });

  test('mounting disabled never applies the saved palette', () => {
    render(<Harness selection={both('dracula')} enabled={false} />);
    expect(document.documentElement.hasAttribute(COLOR_THEME_ATTRIBUTE)).toBe(false);
    expect(localStorage.getItem(COLOR_THEME_PAIR_STORAGE_KEY)).toBeNull();
  });

  test('disabling removes the custom <style> and both FOUC mirror entries', () => {
    const { rerender } = render(<CustomHarness enabled />);
    expect(document.getElementById(CUSTOM_THEME_STYLE_ID)).not.toBeNull();
    expect(readSelectionCache().dark?.css).toContain('--background: #101014;');
    expect(localStorage.getItem(CUSTOM_THEME_STORAGE_KEY)).toBeNull();

    rerender(<CustomHarness enabled={false} />);
    expect(document.documentElement.hasAttribute(COLOR_THEME_ATTRIBUTE)).toBe(false);
    expect(document.getElementById(CUSTOM_THEME_STYLE_ID)).toBeNull();
    expect(localStorage.getItem(COLOR_THEME_PAIR_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(CUSTOM_THEME_STORAGE_KEY)).toBeNull();
  });

  test('re-enabling brings the saved palette back', () => {
    const { rerender } = render(<Harness selection={both('dracula')} enabled={false} />);
    expect(document.documentElement.hasAttribute(COLOR_THEME_ATTRIBUTE)).toBe(false);

    rerender(<Harness selection={both('dracula')} enabled />);
    expect(document.documentElement.getAttribute(COLOR_THEME_ATTRIBUTE)).toBe('dracula');
    expect(readSelectionCache().dark).toEqual({ id: 'dracula', dark: true });
  });
});

describe('applyColorThemeToDom', () => {
  afterEach(resetDom);

  test('is idempotent and clears when the slot holds default', () => {
    apply({ selection: both('gruvbox') });
    expect(document.documentElement.getAttribute(COLOR_THEME_ATTRIBUTE)).toBe('gruvbox');
    apply({ selection: both('default') });
    expect(document.documentElement.hasAttribute(COLOR_THEME_ATTRIBUTE)).toBe(false);
  });

  test('retires the pre-pair single-palette cache', () => {
    localStorage.setItem(COLOR_THEME_STORAGE_KEY, 'monokai');
    apply({ selection: both('gruvbox') });
    expect(localStorage.getItem(COLOR_THEME_STORAGE_KEY)).toBeNull();
  });

  test('retires the previous custom stylesheet cache after writing the self-contained pair', () => {
    localStorage.setItem(
      CUSTOM_THEME_STORAGE_KEY,
      JSON.stringify({ css: 'legacy custom css', dark: true }),
    );

    apply({
      selection: both('custom'),
      customSeed: { background: '#0a0a0a' },
    });

    expect(readSelectionCache().dark?.css).toContain('--background: #0a0a0a;');
    expect(localStorage.getItem(CUSTOM_THEME_STORAGE_KEY)).toBeNull();
  });

  test('a default slot caches the mode it resolves to, so pre-paint needs no palette table', () => {
    apply({ selection: { light: 'default', dark: 'dracula' } });
    expect(readSelectionCache().light).toEqual({ id: 'default', dark: false });
    apply({ selection: { light: 'dracula', dark: 'default' } });
    expect(readSelectionCache().dark).toEqual({ id: 'default', dark: true });
  });
});

describe('applyColorThemeToDom — custom palette', () => {
  afterEach(resetDom);

  test('injects a <style> built from the scheme and caches it for FOUC', () => {
    apply({
      selection: both('custom'),
      customSeed: { background: '#0a0a0a', primary: '#abcdef' },
    });
    expect(document.documentElement.getAttribute(COLOR_THEME_ATTRIBUTE)).toBe('custom');

    const style = document.getElementById(CUSTOM_THEME_STYLE_ID);
    expect(style).not.toBeNull();
    expect(style?.textContent).toContain('html[data-color-theme="custom"]');
    expect(style?.textContent).toContain('--background: #0a0a0a;');
    expect(style?.textContent).toContain('--primary: #abcdef;');

    const cached = readSelectionCache();
    expect(cached.light?.css).toContain('--background: #0a0a0a;');
    expect(cached.dark?.css).toContain('--background: #0a0a0a;');
    expect(cached.dark?.dark).toBe(true);
  });

  test('caches the custom CSS while custom sits in the OTHER slot, without injecting it', () => {
    apply({
      selection: { light: 'custom', dark: 'dracula' },
      slotMode: 'dark',
      customSeed: { background: '#0a0a0a' },
    });
    expect(document.documentElement.getAttribute(COLOR_THEME_ATTRIBUTE)).toBe('dracula');
    expect(document.getElementById(CUSTOM_THEME_STYLE_ID)).toBeNull();
    expect(readSelectionCache().light?.css).toContain('--background: #0a0a0a;');
  });

  test('dropping custom from both slots removes the <style> and the cache', () => {
    apply({ selection: both('custom'), customSeed: { background: '#0a0a0a' } });
    expect(document.getElementById(CUSTOM_THEME_STYLE_ID)).not.toBeNull();

    apply({ selection: both('dracula') });
    expect(document.getElementById(CUSTOM_THEME_STYLE_ID)).toBeNull();
    expect(localStorage.getItem(CUSTOM_THEME_STORAGE_KEY)).toBeNull();
  });

  test('a light background yields a light color-scheme + dark:false cache', () => {
    apply({
      selection: both('custom'),
      customSeed: { background: '#fafafa', foreground: '#111111' },
    });
    const style = document.getElementById(CUSTOM_THEME_STYLE_ID);
    expect(style?.textContent).toContain('color-scheme: light;');
    expect(readSelectionCache().dark?.dark).toBe(false);
  });
});
