import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

const html = readFileSync(resolve(import.meta.dirname, '../../index.html'), 'utf8');
const originalMatchMedia = window.matchMedia;

const PLATFORMS = ['darwin', 'win32', 'linux', undefined] as const;
const THEME_STATES = [
  { theme: 'dark', osDark: false, dark: true },
  { theme: 'light', osDark: true, dark: false },
  { theme: 'system', osDark: true, dark: true },
  { theme: 'system', osDark: false, dark: false },
] as const;
const CASES = PLATFORMS.flatMap((platform) =>
  THEME_STATES.map((state) => ({ ...state, platform, surface: platform ?? 'web' })),
);

function stubOsDarkPreference(osDark: boolean): void {
  window.matchMedia = ((query: string) =>
    ({
      matches: osDark && query.includes('dark'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      onchange: null,
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

describe('desktop pre-paint classes', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'okDesktop');
    window.matchMedia = originalMatchMedia;
    document.documentElement.className = '';
    document.body.className = '';
    localStorage.clear();
  });

  test.each(CASES)(
    'paints $surface under the $theme theme with a dark OS preference $osDark',
    ({ platform, theme, osDark, dark }) => {
      if (platform)
        Object.defineProperty(window, 'okDesktop', { value: { platform }, configurable: true });
      stubOsDarkPreference(osDark);
      const page = new DOMParser().parseFromString(html, 'text/html');
      const script = [...page.head.querySelectorAll('script:not([src]):not([type])')].find(
        (element) => element.textContent?.includes('ok-color-theme-pair-v1'),
      );
      expect(script).toBeDefined();
      localStorage.setItem('ok-theme-v1', theme);
      new Function(script?.textContent ?? '')();
      const expected = [
        ...(dark ? ['dark'] : []),
        ...(platform ? ['electron-mode', `electron-platform-${platform}`] : []),
      ];
      expect([...document.documentElement.classList].sort()).toEqual(expected.sort());
      expect(document.body.classList.contains('electron-mode')).toBe(false);
    },
  );
});
