import type { BrowserWindowConstructorOptions } from 'electron';
import type { OkChromeColors } from '../shared/bridge-contract.ts';

export const TITLEBAR_OVERLAY_HEIGHT = 48;

export const CHROME_BG = { light: '#fafafa', dark: '#171717' } as const;
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
): TitleBarOverlayOptions {
  const { bg, symbol } = chromeColors(isDark, live);
  return {
    color: bg,
    symbolColor: symbol,
    height: TITLEBAR_OVERLAY_HEIGHT,
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

interface ThemeableWindow {
  isDestroyed(): boolean;
  setBackgroundColor(color: string): void;
  setTitleBarOverlay?(options: TitleBarOverlayOptions): void;
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
  if (platform === 'win32' && typeof win.setTitleBarOverlay === 'function') {
    try {
      win.setTitleBarOverlay(computeTitleBarOverlay(isDark, live));
    } catch {}
  }
}
