import {
  APP_HEADER_HEIGHT_PX,
  CHROME_BG_DARK,
  CHROME_BG_LIGHT,
  REDUCED_CHROME_HEADER_HEIGHT_PX,
} from '@inkeep/open-knowledge-core';
import type { BrowserWindowConstructorOptions } from 'electron';
import type { OkChromeColors } from '../shared/bridge-contract.ts';

export const TITLEBAR_OVERLAY_HEIGHT = REDUCED_CHROME_HEADER_HEIGHT_PX;

export const APP_HEADER_TITLEBAR_OVERLAY_HEIGHT = APP_HEADER_HEIGHT_PX;

export const TRAFFIC_LIGHT_POSITION = { x: 22, y: 24 } as const;

const TRAFFIC_LIGHT_BUTTON_HEIGHT = 14;

const FILE_LIST_CONTENT_INSET = 16;

export const APP_HEADER_TRAFFIC_LIGHT_POSITION = {
  x: FILE_LIST_CONTENT_INSET,
  y: (APP_HEADER_TITLEBAR_OVERLAY_HEIGHT - TRAFFIC_LIGHT_BUTTON_HEIGHT) / 2,
} as const;

export type WindowChromeKind = 'app-header' | 'compact';

export const SINGLE_FILE_WINDOW_CHROME_KIND: WindowChromeKind = 'app-header';

export const DEFAULT_WINDOW_CHROME_KIND: WindowChromeKind = 'compact';

function titleBarOverlayHeightForKind(kind: WindowChromeKind): number {
  return kind === 'app-header' ? APP_HEADER_TITLEBAR_OVERLAY_HEIGHT : TITLEBAR_OVERLAY_HEIGHT;
}

export const CHROME_BG = { light: CHROME_BG_LIGHT, dark: CHROME_BG_DARK } as const;
export const CHROME_SYMBOL = { light: '#171717', dark: '#fafafa' } as const;

export interface TitleBarOverlayOptions {
  color: string;
  symbolColor: string;
  height: number;
}

function chromeColors(isDark: boolean, live?: OkChromeColors): OkChromeColors {
  return {
    bg: live?.bg ?? (isDark ? CHROME_BG.dark : CHROME_BG.light),
    symbol: live?.symbol ?? (isDark ? CHROME_SYMBOL.dark : CHROME_SYMBOL.light),
  };
}

export function computeTitleBarOverlay(
  isDark: boolean,
  live?: OkChromeColors,
  height: number = TITLEBAR_OVERLAY_HEIGHT,
): TitleBarOverlayOptions {
  const { bg, symbol } = chromeColors(isDark, live);
  return {
    color: bg,
    symbolColor: symbol,
    height,
  };
}

export function buildNonDarwinChromeOpts(isDark: boolean): BrowserWindowConstructorOptions {
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: computeTitleBarOverlay(isDark),
    backgroundColor: isDark ? CHROME_BG.dark : CHROME_BG.light,
    autoHideMenuBar: true,
  };
}

export function windowChromeOptsForKind(
  kind: WindowChromeKind,
  platform: NodeJS.Platform,
  isDark: boolean,
): BrowserWindowConstructorOptions {
  if (kind === 'compact') return {};
  if (platform === 'darwin') return { trafficLightPosition: APP_HEADER_TRAFFIC_LIGHT_POSITION };
  return {
    titleBarOverlay: computeTitleBarOverlay(isDark, undefined, titleBarOverlayHeightForKind(kind)),
  };
}

interface ThemeableWindow {
  isDestroyed(): boolean;
  setBackgroundColor(color: string): void;
  setTitleBarOverlay?(options: TitleBarOverlayOptions): void;
}

const windowChromeKinds = new WeakMap<ThemeableWindow, WindowChromeKind>();

export function rememberWindowChromeKind(win: ThemeableWindow, kind: WindowChromeKind): void {
  windowChromeKinds.set(win, kind);
}

function windowChromeKindOf(win: ThemeableWindow): WindowChromeKind {
  return windowChromeKinds.get(win) ?? DEFAULT_WINDOW_CHROME_KIND;
}

export function applyThemeToWindow(
  win: ThemeableWindow,
  platform: NodeJS.Platform,
  isDark: boolean,
  live?: OkChromeColors,
): void {
  if (platform === 'darwin' || win.isDestroyed()) return;
  const { bg } = chromeColors(isDark, live);
  try {
    win.setBackgroundColor(bg);
  } catch {}
  if (
    (platform === 'win32' || platform === 'linux') &&
    typeof win.setTitleBarOverlay === 'function'
  ) {
    const height = titleBarOverlayHeightForKind(windowChromeKindOf(win));
    try {
      win.setTitleBarOverlay(computeTitleBarOverlay(isDark, live, height));
    } catch {}
  }
}
