import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import {
  applyColorThemeToDom,
  COLOR_THEME_ATTRIBUTE,
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

function Harness({ colorTheme, enabled }: { colorTheme: string | undefined; enabled?: boolean }) {
  useApplyConfigColorTheme(colorTheme, undefined, enabled ?? true);
  return null;
}

function CustomHarness({ enabled }: { enabled: boolean }) {
  useApplyConfigColorTheme('custom', { background: '#101014' }, enabled);
  return null;
}

describe('useApplyConfigColorTheme', () => {
  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute(COLOR_THEME_ATTRIBUTE);
    try {
      localStorage.removeItem(COLOR_THEME_STORAGE_KEY);
    } catch {}
  });

  test('sets the attribute + FOUC cache for an IDE theme', () => {
    render(<Harness colorTheme="dracula" />);
    expect(document.documentElement.getAttribute(COLOR_THEME_ATTRIBUTE)).toBe('dracula');
    expect(localStorage.getItem(COLOR_THEME_STORAGE_KEY)).toBe('dracula');
  });

  test('clears the attribute + cache when switched back to default', () => {
    const { rerender } = render(<Harness colorTheme="catppuccin-frappe" />);
    expect(document.documentElement.getAttribute(COLOR_THEME_ATTRIBUTE)).toBe('catppuccin-frappe');
    rerender(<Harness colorTheme="default" />);
    expect(document.documentElement.hasAttribute(COLOR_THEME_ATTRIBUTE)).toBe(false);
    expect(localStorage.getItem(COLOR_THEME_STORAGE_KEY)).toBeNull();
  });

  test('treats an unknown id as default (clears the overlay)', () => {
    render(<Harness colorTheme="not-a-real-theme" />);
    expect(document.documentElement.hasAttribute(COLOR_THEME_ATTRIBUTE)).toBe(false);
  });
});

describe('useApplyConfigColorTheme — Themes plugin disabled', () => {
  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute(COLOR_THEME_ATTRIBUTE);
    document.getElementById(CUSTOM_THEME_STYLE_ID)?.remove();
    try {
      localStorage.removeItem(COLOR_THEME_STORAGE_KEY);
      localStorage.removeItem(CUSTOM_THEME_STORAGE_KEY);
    } catch {}
  });

  test('disabling reverts an active named palette to the default', () => {
    const { rerender } = render(<Harness colorTheme="catppuccin-frappe" enabled />);
    expect(document.documentElement.getAttribute(COLOR_THEME_ATTRIBUTE)).toBe('catppuccin-frappe');

    rerender(<Harness colorTheme="catppuccin-frappe" enabled={false} />);
    expect(document.documentElement.hasAttribute(COLOR_THEME_ATTRIBUTE)).toBe(false);
    // The FOUC mirror carries the disabled state — a reload's pre-paint script
    // finds no cached palette, so it cannot flash the palette back.
    expect(localStorage.getItem(COLOR_THEME_STORAGE_KEY)).toBeNull();
  });

  test('mounting disabled never applies the saved palette', () => {
    render(<Harness colorTheme="dracula" enabled={false} />);
    expect(document.documentElement.hasAttribute(COLOR_THEME_ATTRIBUTE)).toBe(false);
    expect(localStorage.getItem(COLOR_THEME_STORAGE_KEY)).toBeNull();
  });

  test('disabling removes the custom <style> and both FOUC mirror entries', () => {
    const { rerender } = render(<CustomHarness enabled />);
    expect(document.getElementById(CUSTOM_THEME_STYLE_ID)).not.toBeNull();
    expect(localStorage.getItem(CUSTOM_THEME_STORAGE_KEY)).not.toBeNull();

    rerender(<CustomHarness enabled={false} />);
    expect(document.documentElement.hasAttribute(COLOR_THEME_ATTRIBUTE)).toBe(false);
    expect(document.getElementById(CUSTOM_THEME_STYLE_ID)).toBeNull();
    expect(localStorage.getItem(COLOR_THEME_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(CUSTOM_THEME_STORAGE_KEY)).toBeNull();
  });

  test('re-enabling brings the saved palette back', () => {
    const { rerender } = render(<Harness colorTheme="dracula" enabled={false} />);
    expect(document.documentElement.hasAttribute(COLOR_THEME_ATTRIBUTE)).toBe(false);

    rerender(<Harness colorTheme="dracula" enabled />);
    expect(document.documentElement.getAttribute(COLOR_THEME_ATTRIBUTE)).toBe('dracula');
    expect(localStorage.getItem(COLOR_THEME_STORAGE_KEY)).toBe('dracula');
  });
});

describe('applyColorThemeToDom', () => {
  afterEach(() => {
    document.documentElement.removeAttribute(COLOR_THEME_ATTRIBUTE);
    try {
      localStorage.removeItem(COLOR_THEME_STORAGE_KEY);
    } catch {}
  });

  test('is idempotent and clears on undefined', () => {
    applyColorThemeToDom('gruvbox');
    expect(document.documentElement.getAttribute(COLOR_THEME_ATTRIBUTE)).toBe('gruvbox');
    applyColorThemeToDom(undefined);
    expect(document.documentElement.hasAttribute(COLOR_THEME_ATTRIBUTE)).toBe(false);
  });
});

describe('applyColorThemeToDom — custom palette', () => {
  afterEach(() => {
    document.documentElement.removeAttribute(COLOR_THEME_ATTRIBUTE);
    document.getElementById(CUSTOM_THEME_STYLE_ID)?.remove();
    try {
      localStorage.removeItem(COLOR_THEME_STORAGE_KEY);
      localStorage.removeItem(CUSTOM_THEME_STORAGE_KEY);
    } catch {}
  });

  test('injects a <style> built from the seed and caches it for FOUC', () => {
    applyColorThemeToDom('custom', { background: '#0a0a0a', primary: '#abcdef' });
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

  test('switching away from custom removes the <style> and the cache', () => {
    applyColorThemeToDom('custom', { background: '#0a0a0a' });
    expect(document.getElementById(CUSTOM_THEME_STYLE_ID)).not.toBeNull();

    applyColorThemeToDom('dracula');
    expect(document.getElementById(CUSTOM_THEME_STYLE_ID)).toBeNull();
    expect(localStorage.getItem(CUSTOM_THEME_STORAGE_KEY)).toBeNull();
  });

  test('a light background yields a light color-scheme + dark:false cache', () => {
    applyColorThemeToDom('custom', { background: '#fafafa', foreground: '#111111' });
    const style = document.getElementById(CUSTOM_THEME_STYLE_ID);
    expect(style?.textContent).toContain('color-scheme: light;');
    const cached = JSON.parse(localStorage.getItem(CUSTOM_THEME_STORAGE_KEY) ?? '{}');
    expect(cached.dark).toBe(false);
  });
});
