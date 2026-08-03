import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import type { ColorThemeSelection } from './color-themes';
import {
  type ApplyColorThemeInput,
  applyColorThemeToDom,
  COLOR_THEME_ATTRIBUTE,
  COLOR_THEME_PAIR_STORAGE_KEY,
  COLOR_THEME_STORAGE_KEY,
  CUSTOM_THEME_STORAGE_KEY,
  CUSTOM_THEME_STYLE_ID,
  useApplyConfigColorTheme,
} from './use-apply-config-color-theme';

// The jsdom preload installs `window` but not a top-level `localStorage`
// global; production runs in a real browser where it is global. Bridge it so
// the FOUC-cache writes are observable here.
beforeAll(() => {
  if (typeof localStorage === 'undefined') {
    (globalThis as { localStorage?: Storage }).localStorage = window.localStorage;
  }
});

/** A selection with the same palette in both slots — the pre-pair shape. */
function both(id: ColorThemeSelection['light']): ColorThemeSelection {
  return { light: id, dark: id };
}

function apply(input: Partial<ApplyColorThemeInput> & { selection: ColorThemeSelection }): void {
  applyColorThemeToDom({ modePreference: 'dark', slotMode: 'dark', ...input });
}

function readSelectionCache(): {
  pref?: string;
  light?: { id: string; dark: boolean };
  dark?: { id: string; dark: boolean };
} {
  return JSON.parse(localStorage.getItem(COLOR_THEME_PAIR_STORAGE_KEY) ?? '{}');
}

function Harness({
  selection,
  slotMode = 'dark',
  enabled,
}: {
  selection: ColorThemeSelection;
  slotMode?: 'light' | 'dark';
  enabled?: boolean;
}) {
  useApplyConfigColorTheme({
    selection,
    modePreference: slotMode,
    slotMode,
    enabled: enabled ?? true,
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

  test('caches BOTH slots, so a reload landing in the other mode still pre-paints', () => {
    render(<Harness selection={{ light: 'catppuccin-latte', dark: 'dracula' }} slotMode="dark" />);
    const cached = readSelectionCache();
    expect(cached.light).toEqual({ id: 'catppuccin-latte', dark: false });
    expect(cached.dark).toEqual({ id: 'dracula', dark: true });
  });

  test("caches the mode preference, not next-themes' possibly-forced value", () => {
    // A palette forces its own variant through `setTheme`, so `ok-theme-v1` can
    // read 'dark' while the user's preference is still 'system'. Picking a slot
    // from that would strand the app in one mode.
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
    // Any palette may sit in either slot; it keeps forcing its own variant so
    // Tailwind `dark:` variants resolve against the tokens actually on screen.
    render(<Harness selection={{ light: 'dracula', dark: 'dracula' }} slotMode="light" />);
    expect(readSelectionCache().light).toEqual({ id: 'dracula', dark: true });
  });

  test('treats an unknown id as default (clears the overlay)', () => {
    render(<Harness selection={both('not-a-real-theme' as ColorThemeSelection['light'])} />);
    expect(document.documentElement.hasAttribute(COLOR_THEME_ATTRIBUTE)).toBe(false);
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
    // The FOUC mirror carries the disabled state — a reload's pre-paint script
    // finds no cached palette, so it cannot flash the palette back.
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
    expect(localStorage.getItem(CUSTOM_THEME_STORAGE_KEY)).not.toBeNull();

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
    // Left behind, it would shadow a reset back to `default` on the next
    // pre-paint — the fallback branch only runs when the pair is absent.
    localStorage.setItem(COLOR_THEME_STORAGE_KEY, 'monokai');
    apply({ selection: both('gruvbox') });
    expect(localStorage.getItem(COLOR_THEME_STORAGE_KEY)).toBeNull();
  });

  test('a default slot caches the mode it resolves to, so pre-paint needs no palette table', () => {
    // `default` carries no palette, so its cached flag is just the slot's own
    // mode — which is what lets the pre-paint script set the `dark` class
    // without knowing a single theme id.
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

    const cached = JSON.parse(localStorage.getItem(CUSTOM_THEME_STORAGE_KEY) ?? '{}');
    expect(cached.css).toContain('--background: #0a0a0a;');
    expect(cached.dark).toBe(true);
  });

  test('caches the custom CSS while custom sits in the OTHER slot, without injecting it', () => {
    // The OS can flip while the app is closed, so the reload that lands in the
    // custom slot has to be able to replay the stylesheet pre-paint.
    apply({
      selection: { light: 'custom', dark: 'dracula' },
      slotMode: 'dark',
      customSeed: { background: '#0a0a0a' },
    });
    expect(document.documentElement.getAttribute(COLOR_THEME_ATTRIBUTE)).toBe('dracula');
    expect(document.getElementById(CUSTOM_THEME_STYLE_ID)).toBeNull();
    expect(localStorage.getItem(CUSTOM_THEME_STORAGE_KEY)).not.toBeNull();
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
    const cached = JSON.parse(localStorage.getItem(CUSTOM_THEME_STORAGE_KEY) ?? '{}');
    expect(cached.dark).toBe(false);
  });
});
