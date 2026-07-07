import type { ITheme } from '@xterm/xterm';

/**
 * Curated xterm palettes for the docked terminal, one per resolved app mode.
 *
 * Hand-tuned rather than derived from the app's CSS tokens: xterm's 16 ANSI
 * slots have no clean mapping onto the app's semantic tokens, and a curated
 * pair gives correct contrast in both modes. The surface colors track the
 * neutral `--background`/`--foreground` tokens closely enough to blend with the
 * `bg-background` wrapper; the ANSI slots follow the VS Code terminal palettes,
 * which are tuned for legibility. `minimumContrastRatio` on the Terminal lifts
 * any remaining low-contrast program output toward AA at render time.
 */
export const XTERM_DARK_THEME = {
  background: '#171717',
  foreground: '#e5e5e5',
  cursor: '#e5e5e5',
  cursorAccent: '#171717',
  selectionBackground: '#3a3d41',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
} satisfies ITheme;

export const XTERM_LIGHT_THEME = {
  background: '#ffffff',
  foreground: '#262626',
  cursor: '#262626',
  cursorAccent: '#ffffff',
  selectionBackground: '#add6ff',
  black: '#000000',
  red: '#cd3131',
  green: '#00bc00',
  yellow: '#949800',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#14ce14',
  brightYellow: '#b5ba00',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#a5a5a5',
} satisfies ITheme;

/**
 * Pick the xterm palette for a next-themes `resolvedTheme` (already collapsed
 * from `system` to `light`/`dark`). Anything other than `dark` — including the
 * pre-mount `undefined` — resolves to light, matching the sibling theme-aware
 * viewers.
 */
export function xtermThemeForMode(resolvedTheme: string | undefined): ITheme {
  return resolvedTheme === 'dark' ? XTERM_DARK_THEME : XTERM_LIGHT_THEME;
}
