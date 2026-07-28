/**
 * Per-platform window-chrome construction options (the windows-linux-port
 * chrome decision). macOS keeps the vibrancy/hiddenInset stack composed in `index.ts`;
 * this module owns the Windows/Linux half: `titleBarStyle: 'hidden'` +
 * `titleBarOverlay` (OS-drawn min/max/close floating over the renderer's
 * chrome row — the standard cross-platform frameless pattern) and a solid
 * theme-matched `backgroundColor` (no vibrancy analog off-mac; the
 * renderer's alpha-tinted surfaces composite over this solid base).
 *
 * Color values are the resolved `--sidebar` chrome tokens — the same values
 * `chrome-tokens-vite-plugin.ts` substitutes into `packages/app/index.html`'s
 * FOUC guard (`__OK_CHROME_BG_LIGHT__` / `__OK_CHROME_BG_DARK__`, resolved
 * from `globals.css`). Keep in lockstep with that plugin's committed
 * expectations: light `#fafafa` / dark `#171717`.
 *
 * The overlay height matches the renderer's `EditorHeader` chrome row
 * (`h-12` = 48px) so the OS controls vertically center on the same row the
 * custom menubar and drag region live in.
 *
 * Theme reactivity: construction options are read once per window, so
 * `index.ts` re-applies on `nativeTheme` 'updated' via
 * `applyThemeToWindow` — `setTitleBarOverlay` is Windows-only in Electron
 * (Linux keeps its creation-time overlay colors until relaunch; cosmetic
 * only), `setBackgroundColor` works everywhere.
 */

import type { BrowserWindowConstructorOptions } from 'electron';

export const TITLEBAR_OVERLAY_HEIGHT = 48;

export const CHROME_BG = { light: '#fafafa', dark: '#171717' } as const;
/** Symbol (glyph) color for the overlay window controls — the theme's foreground. */
export const CHROME_SYMBOL = { light: '#171717', dark: '#fafafa' } as const;

export interface TitleBarOverlayOptions {
  color: string;
  symbolColor: string;
  height: number;
}

export function computeTitleBarOverlay(isDark: boolean): TitleBarOverlayOptions {
  return {
    color: isDark ? CHROME_BG.dark : CHROME_BG.light,
    symbolColor: isDark ? CHROME_SYMBOL.dark : CHROME_SYMBOL.light,
    height: TITLEBAR_OVERLAY_HEIGHT,
  };
}

/**
 * The non-darwin slice of `DEFAULT_WIN_OPTS`. `autoHideMenuBar` keeps the
 * native menu bar (still installed for its accelerators — the renderer-menubar contract keeps
 * shortcuts on the hidden main-process Menu) from rendering a second menu
 * row above the custom titlebar chrome; Alt-taps on Windows can still
 * transiently summon it, which is acceptable (it holds the same items the
 * renderer menubar draws).
 */
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

/**
 * Re-apply theme-derived chrome to a live window after a theme flip.
 * Never throws: `setTitleBarOverlay` is Windows-only and also throws on
 * windows created without an overlay (e.g. if a future window type opts
 * out) — chrome recolor is cosmetic and must not take down the theme
 * handler.
 */
export function applyThemeToWindow(
  win: ThemeableWindow,
  platform: NodeJS.Platform,
  isDark: boolean,
): void {
  if (platform === 'darwin' || win.isDestroyed()) return;
  try {
    win.setBackgroundColor(isDark ? CHROME_BG.dark : CHROME_BG.light);
  } catch {
    // destroyed mid-iteration — nothing to recolor
  }
  if (platform === 'win32' && typeof win.setTitleBarOverlay === 'function') {
    try {
      win.setTitleBarOverlay(computeTitleBarOverlay(isDark));
    } catch {
      // overlay-less window (or platform refusal) — cosmetic, skip
    }
  }
}
