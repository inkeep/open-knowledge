import { describe, expect, test } from 'vitest';
import {
  computeLiveXtermTheme,
  XTERM_DARK_THEME,
  XTERM_LIGHT_THEME,
  xtermThemeForMode,
} from './terminal-theme';

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

function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

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
    expect(luminance(XTERM_LIGHT_THEME.background)).toBeGreaterThan(0.5);
    expect(luminance(XTERM_LIGHT_THEME.foreground)).toBeLessThan(0.5);
    expect(luminance(XTERM_DARK_THEME.background)).toBeLessThan(0.5);
    expect(luminance(XTERM_DARK_THEME.foreground)).toBeGreaterThan(0.5);
  });

  test('both palettes meet WCAG AA contrast for primary text on the terminal surface', () => {
    expect(
      contrastRatio(XTERM_LIGHT_THEME.foreground, XTERM_LIGHT_THEME.background),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(XTERM_DARK_THEME.foreground, XTERM_DARK_THEME.background),
    ).toBeGreaterThanOrEqual(4.5);
  });
});

describe('computeLiveXtermTheme', () => {
  const reader = (tokens: Record<string, string>) => (token: string) => tokens[token] ?? null;

  test('overrides surface slots from resolved theme tokens', () => {
    const theme = computeLiveXtermTheme(
      'dark',
      reader({
        '--background': 'rgb(20, 24, 34)',
        '--foreground': 'rgb(220, 224, 234)',
        '--selection-soft': 'rgba(90, 120, 255, 0.3)',
      }),
    );
    expect(theme.background).toBe('rgb(20, 24, 34)');
    expect(theme.foreground).toBe('rgb(220, 224, 234)');
    expect(theme.cursor).toBe('rgb(220, 224, 234)');
    expect(theme.cursorAccent).toBe('rgb(20, 24, 34)');
    expect(theme.selectionBackground).toBe('rgba(90, 120, 255, 0.3)');
  });

  test('keeps the curated ANSI slots for the mode', () => {
    const theme = computeLiveXtermTheme('dark', reader({ '--background': 'rgb(1, 2, 3)' }));
    for (const slot of ANSI_16) expect(theme[slot]).toBe(XTERM_DARK_THEME[slot]);
  });

  test('overrides ANSI slots from resolved --ansi-* tokens, per slot', () => {
    const theme = computeLiveXtermTheme(
      'dark',
      reader({
        '--ansi-red': 'rgb(200, 0, 0)',
        '--ansi-yellow': 'rgb(220, 200, 0)',
        '--ansi-bright-green': 'rgb(0, 220, 100)',
      }),
    );
    expect(theme.red).toBe('rgb(200, 0, 0)');
    expect(theme.yellow).toBe('rgb(220, 200, 0)');
    expect(theme.brightGreen).toBe('rgb(0, 220, 100)');
    expect(theme.blue).toBe(XTERM_DARK_THEME.blue);
    expect(theme.brightRed).toBe(XTERM_DARK_THEME.brightRed);
  });

  test('falls back to the curated palette when tokens do not resolve', () => {
    expect(computeLiveXtermTheme('dark', () => null)).toEqual(XTERM_DARK_THEME);
    expect(computeLiveXtermTheme('light', () => null)).toEqual(XTERM_LIGHT_THEME);
  });

  test('partial resolution falls back per slot', () => {
    const theme = computeLiveXtermTheme('light', reader({ '--background': 'rgb(9, 9, 9)' }));
    expect(theme.background).toBe('rgb(9, 9, 9)');
    expect(theme.foreground).toBe(XTERM_LIGHT_THEME.foreground);
    expect(theme.selectionBackground).toBe(XTERM_LIGHT_THEME.selectionBackground);
  });

  test('the default reader yields the curated palette when there is no DOM', () => {
    expect(typeof document).toBe('undefined');
    expect(() => computeLiveXtermTheme('dark')).not.toThrow();
    expect(computeLiveXtermTheme('dark')).toEqual(XTERM_DARK_THEME);
    expect(computeLiveXtermTheme('light')).toEqual(XTERM_LIGHT_THEME);
  });
});
