import { APP_HEADER_HEIGHT, REDUCED_CHROME_HEADER_HEIGHT } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import type { OkChromeColors } from '../shared/bridge-contract.ts';
import { noteWindowNativeChromeOptions } from './note-window.ts';
import {
  APP_HEADER_TITLEBAR_OVERLAY_HEIGHT,
  APP_HEADER_TRAFFIC_LIGHT_POSITION,
  applyThemeToWindow,
  buildNonDarwinChromeOpts,
  CHROME_BG,
  CHROME_SYMBOL,
  computeTitleBarOverlay,
  rememberWindowChromeKind,
  SINGLE_FILE_WINDOW_CHROME_KIND,
  TITLEBAR_OVERLAY_HEIGHT,
  TRAFFIC_LIGHT_POSITION,
  windowChromeOptsForKind,
} from './window-chrome.ts';

const ROOT_FONT_SIZE_PX = 16;

const MACOS_TRAFFIC_LIGHT_DIAMETER_PX = 14;

function remToPx(rem: string): number {
  expect(rem).toMatch(/^\d+(?:\.\d+)?rem$/);
  return Number.parseFloat(rem) * ROOT_FONT_SIZE_PX;
}

const REDUCED_CHROME_BAR_PX = remToPx(REDUCED_CHROME_HEADER_HEIGHT);

const LIVE: OkChromeColors = { bg: '#282a36', symbol: '#f8f8f2' };

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

  test('overlay height matches the renderer reduced-chrome top bar', () => {
    expect(TITLEBAR_OVERLAY_HEIGHT).toBe(REDUCED_CHROME_BAR_PX);
  });

  test('the app-header overlay height is the renderer app header height', () => {
    expect(APP_HEADER_HEIGHT).toMatch(/^\d+(?:\.\d+)?rem$/);
    expect(Number.parseFloat(APP_HEADER_HEIGHT) * ROOT_FONT_SIZE_PX).toBe(
      APP_HEADER_TITLEBAR_OVERLAY_HEIGHT,
    );
  });

  test('an explicit height overrides the shared default', () => {
    expect(computeTitleBarOverlay(false, undefined, APP_HEADER_TITLEBAR_OVERLAY_HEIGHT)).toEqual({
      color: CHROME_BG.light,
      symbolColor: CHROME_SYMBOL.light,
      height: APP_HEADER_TITLEBAR_OVERLAY_HEIGHT,
    });
  });

  test('chrome tokens stay in lockstep with the committed FOUC-guard values', () => {
    expect(CHROME_BG.light).toBe('#f5f5f5');
    expect(CHROME_BG.dark).toBe('#292929');
  });

  test("the renderer's live colors take precedence over the default-theme snapshot", () => {
    expect(computeTitleBarOverlay(true, LIVE)).toEqual({
      color: LIVE.bg,
      symbolColor: LIVE.symbol,
      height: TITLEBAR_OVERLAY_HEIGHT,
    });
  });

  test('live colors win in either mode — the palette, not isDark, picks them', () => {
    expect(computeTitleBarOverlay(false, LIVE)).toEqual(computeTitleBarOverlay(true, LIVE));
  });

  test('falls back to the snapshot when live is absent (pre-renderer-mount)', () => {
    expect(computeTitleBarOverlay(true, undefined)).toEqual(computeTitleBarOverlay(true));
  });
});

describe('buildNonDarwinChromeOpts', () => {
  test('hidden titlebar + overlay + solid theme background + hidden native menu row', () => {
    const opts = buildNonDarwinChromeOpts(true);
    expect(opts.titleBarStyle).toBe('hidden');
    expect(opts.titleBarOverlay).toEqual(computeTitleBarOverlay(true));
    expect(opts.backgroundColor).toBe(CHROME_BG.dark);
    expect(opts.autoHideMenuBar).toBe(true);
    expect('vibrancy' in opts).toBe(false);
    expect('transparent' in opts).toBe(false);
  });
});

describe('windowChromeOptsForKind', () => {
  test('a compact window keeps every shared default on every platform', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(windowChromeOptsForKind('compact', platform, true)).toEqual({});
    }
    expect(TRAFFIC_LIGHT_POSITION).toEqual({ x: 22, y: 24 });
  });

  test('an app-header window raises the macOS traffic lights into the 44px header and lines them up with the file list', () => {
    expect(windowChromeOptsForKind('app-header', 'darwin', true)).toEqual({
      trafficLightPosition: APP_HEADER_TRAFFIC_LIGHT_POSITION,
    });
    expect(APP_HEADER_TRAFFIC_LIGHT_POSITION).toEqual({ x: 16, y: 15 });
  });

  test('the app-header traffic lights sit as far above the header centre as the note window tunes them in its bar', () => {
    const noteY = noteWindowNativeChromeOptions('darwin').trafficLightPosition?.y;
    expect(noteY).toBeDefined();
    const noteInsetFromCentre = TITLEBAR_OVERLAY_HEIGHT / 2 - (noteY ?? 0);
    const appHeaderInsetFromCentre =
      APP_HEADER_TITLEBAR_OVERLAY_HEIGHT / 2 - APP_HEADER_TRAFFIC_LIGHT_POSITION.y;
    expect(appHeaderInsetFromCentre).toBe(noteInsetFromCentre);
  });

  test('a single-file window takes the chrome of the shared header it renders', () => {
    expect(SINGLE_FILE_WINDOW_CHROME_KIND).toBe('app-header');
    const position = windowChromeOptsForKind(
      SINGLE_FILE_WINDOW_CHROME_KIND,
      'darwin',
      true,
    ).trafficLightPosition;
    expect((position?.y ?? 0) + MACOS_TRAFFIC_LIGHT_DIAMETER_PX / 2).toBe(
      remToPx(APP_HEADER_HEIGHT) / 2,
    );
    expect(windowChromeOptsForKind(SINGLE_FILE_WINDOW_CHROME_KIND, 'win32', true)).toEqual({
      titleBarOverlay: computeTitleBarOverlay(true, undefined, remToPx(APP_HEADER_HEIGHT)),
    });
  });

  test.each(['win32', 'linux'] as const)(
    'an app-header window shrinks the %s overlay to the header height',
    (platform) => {
      expect(windowChromeOptsForKind('app-header', platform, true)).toEqual({
        titleBarOverlay: computeTitleBarOverlay(
          true,
          undefined,
          APP_HEADER_TITLEBAR_OVERLAY_HEIGHT,
        ),
      });
    },
  );
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

  test('linux recolors background AND overlay', () => {
    const { win, calls } = makeWin();
    applyThemeToWindow(win, 'linux', false);
    expect(calls.bg).toEqual([CHROME_BG.light]);
    expect(calls.overlay).toEqual([computeTitleBarOverlay(false)]);
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

  test('a theme repaint keeps an app-header window on the header-sized overlay', () => {
    const { win, calls } = makeWin();
    rememberWindowChromeKind(win, 'app-header');
    applyThemeToWindow(win, 'win32', true);
    expect(calls.overlay).toEqual([
      computeTitleBarOverlay(true, undefined, APP_HEADER_TITLEBAR_OVERLAY_HEIGHT),
    ]);
  });

  test('a theme repaint leaves an unregistered window on the shared 48px overlay', () => {
    const { win, calls } = makeWin();
    applyThemeToWindow(win, 'win32', true);
    expect(calls.overlay).toEqual([computeTitleBarOverlay(true, undefined, 48)]);
  });

  test('win32 repaints background AND overlay from the live palette', () => {
    const { win, calls } = makeWin();
    applyThemeToWindow(win, 'win32', true, LIVE);
    expect(calls.bg).toEqual([LIVE.bg]);
    expect(calls.overlay).toEqual([computeTitleBarOverlay(true, LIVE)]);
  });

  test('linux repaints the background AND overlay from the live palette', () => {
    const { win, calls } = makeWin();
    applyThemeToWindow(win, 'linux', false, LIVE);
    expect(calls.bg).toEqual([LIVE.bg]);
    expect(calls.overlay).toEqual([computeTitleBarOverlay(false, LIVE)]);
  });
});
