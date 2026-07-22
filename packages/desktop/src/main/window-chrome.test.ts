import { describe, expect, test } from 'vitest';
import {
  applyThemeToWindow,
  buildNonDarwinChromeOpts,
  CHROME_BG,
  CHROME_SYMBOL,
  computeTitleBarOverlay,
  TITLEBAR_OVERLAY_HEIGHT,
} from './window-chrome.ts';

describe('computeTitleBarOverlay', () => {
  test('light theme uses light bg + dark symbols', () => {
    expect(computeTitleBarOverlay(false)).toEqual({
      color: CHROME_BG.light,
      symbolColor: CHROME_SYMBOL.light,
      height: TITLEBAR_OVERLAY_HEIGHT,
    });
  });

  test('dark theme uses dark bg + light symbols', () => {
    expect(computeTitleBarOverlay(true)).toEqual({
      color: CHROME_BG.dark,
      symbolColor: CHROME_SYMBOL.dark,
      height: TITLEBAR_OVERLAY_HEIGHT,
    });
  });

  test('overlay height matches the renderer chrome row (EditorHeader h-12)', () => {
    expect(TITLEBAR_OVERLAY_HEIGHT).toBe(48);
  });

  test('chrome tokens stay in lockstep with the committed FOUC-guard values', () => {
    // chrome-tokens-vite-plugin.ts resolves --sidebar to exactly these and
    // substitutes them into packages/app/index.html; the window chrome must
    // paint the same solid base or first-frame chrome mismatches the page.
    expect(CHROME_BG.light).toBe('#fafafa');
    expect(CHROME_BG.dark).toBe('#171717');
  });
});

describe('buildNonDarwinChromeOpts', () => {
  test('hidden titlebar + overlay + solid theme background + hidden native menu row', () => {
    const opts = buildNonDarwinChromeOpts(true);
    expect(opts.titleBarStyle).toBe('hidden');
    expect(opts.titleBarOverlay).toEqual(computeTitleBarOverlay(true));
    expect(opts.backgroundColor).toBe(CHROME_BG.dark);
    expect(opts.autoHideMenuBar).toBe(true);
    // The darwin-only vibrancy stack must never leak in here — a transparent
    // frameless window with no vibrancy is the "no usable chrome" failure
    // mode this module exists to fix.
    expect('vibrancy' in opts).toBe(false);
    expect('transparent' in opts).toBe(false);
  });
});

describe('applyThemeToWindow', () => {
  function makeWin(overrides: { destroyed?: boolean; overlayThrows?: boolean } = {}) {
    const calls: { bg: string[]; overlay: unknown[] } = { bg: [], overlay: [] };
    return {
      calls,
      win: {
        isDestroyed: () => overrides.destroyed ?? false,
        setBackgroundColor: (c: string) => calls.bg.push(c),
        setTitleBarOverlay: (o: unknown) => {
          if (overrides.overlayThrows) throw new Error('no overlay on this window');
          calls.overlay.push(o);
        },
      },
    };
  }

  test('darwin is a no-op (vibrancy tracks nativeTheme automatically)', () => {
    const { win, calls } = makeWin();
    applyThemeToWindow(win, 'darwin', true);
    expect(calls.bg).toHaveLength(0);
    expect(calls.overlay).toHaveLength(0);
  });

  test('win32 recolors background AND overlay', () => {
    const { win, calls } = makeWin();
    applyThemeToWindow(win, 'win32', true);
    expect(calls.bg).toEqual([CHROME_BG.dark]);
    expect(calls.overlay).toEqual([computeTitleBarOverlay(true)]);
  });

  test('linux recolors background only (setTitleBarOverlay is Windows-only)', () => {
    const { win, calls } = makeWin();
    applyThemeToWindow(win, 'linux', false);
    expect(calls.bg).toEqual([CHROME_BG.light]);
    expect(calls.overlay).toHaveLength(0);
  });

  test('destroyed window is skipped entirely', () => {
    const { win, calls } = makeWin({ destroyed: true });
    applyThemeToWindow(win, 'win32', true);
    expect(calls.bg).toHaveLength(0);
    expect(calls.overlay).toHaveLength(0);
  });

  test('an overlay-less window (setTitleBarOverlay throws) never propagates', () => {
    const { win, calls } = makeWin({ overlayThrows: true });
    expect(() => applyThemeToWindow(win, 'win32', false)).not.toThrow();
    expect(calls.bg).toEqual([CHROME_BG.light]);
  });
});
