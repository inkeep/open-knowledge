import { describe, expect, test } from 'bun:test';
import { XTERM_DARK_THEME, XTERM_LIGHT_THEME, xtermThemeForMode } from './terminal-theme';

/** WCAG relative luminance of a `#rrggbb` color, in [0, 1]. */
function luminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (m === null) throw new Error(`not a #rrggbb color: ${hex}`);
  const channel = (pair: string): number => {
    const c = Number.parseInt(pair, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [, r, g, b] = m as unknown as [string, string, string, string];
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two `#rrggbb` colors, in [1, 21]. */
function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// The slots a curated xterm palette must define: the 16 ANSI colors plus the
// surface colors. Selecting the wrong subset (e.g. omitting bright variants)
// leaves ANSI output rendering in xterm defaults that clash with the mode.
const ANSI_16 = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;
const SURFACE = ['background', 'foreground', 'cursor', 'selectionBackground'] as const;

describe('xtermThemeForMode', () => {
  test('selects the dark palette only for the resolved dark mode', () => {
    expect(xtermThemeForMode('dark')).toBe(XTERM_DARK_THEME);
  });

  test('selects the light palette for light mode', () => {
    expect(xtermThemeForMode('light')).toBe(XTERM_LIGHT_THEME);
  });

  test('defaults to the light palette when the theme is not yet resolved', () => {
    // next-themes reports `undefined` until it mounts; falling back to light
    // matches the sibling theme-aware viewers (DiffView, TextViewer).
    expect(xtermThemeForMode(undefined)).toBe(XTERM_LIGHT_THEME);
  });
});

describe('curated xterm palettes', () => {
  for (const [name, palette] of [
    ['light', XTERM_LIGHT_THEME],
    ['dark', XTERM_DARK_THEME],
  ] as const) {
    test(`${name} palette defines all 16 ANSI slots plus the surface colors`, () => {
      const theme = palette as Record<string, unknown>;
      for (const slot of [...ANSI_16, ...SURFACE]) {
        expect(typeof theme[slot]).toBe('string');
        expect(theme[slot]).toMatch(/^#[0-9a-f]{6}$/i);
      }
    });
  }

  test('the light palette is light-on-dark-text and the dark palette is dark-on-light-text', () => {
    // The whole point: each mode is legible in its mode. A swapped
    // light/dark assignment (the classic regression) flips these.
    expect(luminance(XTERM_LIGHT_THEME.background)).toBeGreaterThan(0.5);
    expect(luminance(XTERM_LIGHT_THEME.foreground)).toBeLessThan(0.5);
    expect(luminance(XTERM_DARK_THEME.background)).toBeLessThan(0.5);
    expect(luminance(XTERM_DARK_THEME.foreground)).toBeGreaterThan(0.5);
  });

  test('both palettes meet WCAG AA contrast for primary text on the terminal surface', () => {
    // Polarity (above) only proves legible-side-up; this pins the actual ratio so
    // a future surface/foreground tweak that drops primary text below AA is caught
    // statically. xterm's runtime `minimumContrastRatio` only lifts ANSI program
    // output — it does not cover these primary fg/bg surface colors.
    expect(
      contrastRatio(XTERM_LIGHT_THEME.foreground, XTERM_LIGHT_THEME.background),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(XTERM_DARK_THEME.foreground, XTERM_DARK_THEME.background),
    ).toBeGreaterThanOrEqual(4.5);
  });
});
