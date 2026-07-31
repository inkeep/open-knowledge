import type { AnsiSlotName } from '@inkeep/open-knowledge-core';
import type { ITheme } from '@xterm/xterm';

/**
 * Fallback xterm palettes for the docked terminal, one per resolved app mode.
 *
 * `computeLiveXtermTheme` normally derives every slot from the live theme
 * tokens; these are what it falls back to per-slot when a token can't be
 * resolved (off-DOM, tests) and what the `default` theme's own `--ansi-*`
 * values were seeded from. The ANSI slots follow the VS Code terminal
 * palettes, which are tuned for legibility.
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

/** Resolve one design token (`--background`, …) to a concrete color, or null. */
export type TokenColorReader = (token: string) => string | null;

/**
 * Default token reader: a detached-then-attached probe span whose
 * `backgroundColor` is `var(<token>)`, read back through `getComputedStyle`.
 * The round-trip makes the browser resolve `var()` chains and relative color
 * syntax (`oklch(from var(--primary) …)`) to a concrete color string, which
 * xterm's browser build can parse via its canvas litmus. Returns null when the
 * token is unset or the environment can't resolve it (tests, SSR).
 */
function readTokenColor(token: string): string | null {
  try {
    const probe = document.createElement('span');
    probe.style.display = 'none';
    probe.style.backgroundColor = `var(${token})`;
    document.body.appendChild(probe);
    try {
      const resolved = getComputedStyle(probe).backgroundColor;
      // An unset token computes to the transparent initial value — treat as
      // absent rather than skinning the terminal invisible. A value still
      // containing `var(` means the environment didn't resolve custom
      // properties (happy-dom in tests) — also absent.
      if (!resolved || resolved === 'rgba(0, 0, 0, 0)' || resolved === 'transparent') return null;
      if (resolved.includes('var(')) return null;
      return resolved;
    } finally {
      probe.remove();
    }
  } catch {
    return null;
  }
}

/** xterm ANSI slot → the `--ansi-*` custom property carrying its color. */
const ANSI_TOKEN_BY_SLOT: Record<AnsiSlotName, string> = {
  black: '--ansi-black',
  red: '--ansi-red',
  green: '--ansi-green',
  yellow: '--ansi-yellow',
  blue: '--ansi-blue',
  magenta: '--ansi-magenta',
  cyan: '--ansi-cyan',
  white: '--ansi-white',
  brightBlack: '--ansi-bright-black',
  brightRed: '--ansi-bright-red',
  brightGreen: '--ansi-bright-green',
  brightYellow: '--ansi-bright-yellow',
  brightBlue: '--ansi-bright-blue',
  brightMagenta: '--ansi-bright-magenta',
  brightCyan: '--ansi-bright-cyan',
  brightWhite: '--ansi-bright-white',
};

/**
 * The live theme as an xterm palette — surfaces and all sixteen ANSI slots read
 * from the app's tokens, so a color theme repaints program output and not just
 * the terminal's chrome.
 *
 * The ANSI slots are readable because every theme is authored in base16, whose
 * accent slots are defined against ANSI in the first place; a palette keyed by
 * app-semantic names carries no such mapping and leaves these unreachable.
 * `minimumContrastRatio` on the Terminal still lifts low-contrast program
 * output at render time.
 *
 * Any token that fails to resolve falls back to the curated value, so this
 * degrades to `xtermThemeForMode` off-DOM (tests, SSR).
 */
export function computeLiveXtermTheme(
  resolvedTheme: string | undefined,
  readToken: TokenColorReader = readTokenColor,
): ITheme {
  const base = xtermThemeForMode(resolvedTheme);
  const background = readToken('--background') ?? base.background;
  const foreground = readToken('--foreground') ?? base.foreground;

  const ansi: Partial<Record<AnsiSlotName, string>> = {};
  for (const slot of Object.keys(ANSI_TOKEN_BY_SLOT) as AnsiSlotName[]) {
    const resolved = readToken(ANSI_TOKEN_BY_SLOT[slot]);
    if (resolved) ansi[slot] = resolved;
  }

  return {
    ...base,
    ...ansi,
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: readToken('--selection-soft') ?? base.selectionBackground,
  };
}
