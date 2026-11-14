import { contrastRatio, relativeLuminance } from '@inkeep/open-knowledge-core/theme/base16';
import { describe, expect, test } from 'vitest';
import {
  fallbackGraphPalette,
  type GraphPalette,
  type GraphTokenReader,
  graphPaletteFrom,
  visibleOn,
  withAlpha,
} from './graph-theme';

describe('withAlpha', () => {
  test('applies the alpha to a resolved color', () => {
    expect(withAlpha('#3366cc', 0.5)).toBe('#3366cc80');
  });

  test('multiplies into a color that already carries alpha', () => {
    expect(withAlpha('#3366cc80', 0.5)).toBe('#3366cc40');
  });

  test('leaves a color it cannot read unchanged', () => {
    expect(withAlpha('transparent', 0.5)).toBe('transparent');
  });
});

describe('visibleOn', () => {
  test('keeps a theme color that already stands out from the canvas', () => {
    expect(visibleOn('#1d4ed8ff', '#ffffffff', '#111111ff')).toBe('#1d4ed8');
  });

  test('moves a faint theme color toward the text color until it reaches 3:1 on the canvas', () => {
    const faint = '#a5f3fc';
    const shown = visibleOn(`${faint}ff`, '#ffffffff', '#111111ff');
    expect(contrastRatio(faint, '#ffffff')).toBeLessThan(3);
    expect(contrastRatio(shown, '#ffffff')).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(shown, faint)).toBeLessThan(contrastRatio('#111111', faint));
  });

  test('lightens a faint color toward light text on a dark canvas', () => {
    const faint = '#2a2f45';
    const shown = visibleOn(`${faint}ff`, '#111111ff', '#f5f5f5ff');
    expect(contrastRatio(faint, '#111111')).toBeLessThan(3);
    expect(contrastRatio(shown, '#111111')).toBeGreaterThanOrEqual(3);
    expect(relativeLuminance(shown)).toBeGreaterThan(relativeLuminance(faint));
    expect(contrastRatio(shown, faint)).toBeLessThan(contrastRatio('#f5f5f5', faint));
  });

  test('keeps a theme color between 3:1 and 4.5:1 as entered', () => {
    const accent = '#268bd2';
    const ratio = contrastRatio(accent, '#002b36');
    expect(ratio).toBeGreaterThanOrEqual(3);
    expect(ratio).toBeLessThan(4.5);
    expect(visibleOn(`${accent}ff`, '#002b36ff', '#93a1a1ff')).toBe(accent);
  });

  test('leaves a color it cannot read unchanged', () => {
    expect(visibleOn('transparent', '#ffffffff', '#111111ff')).toBe('transparent');
  });
});

type Token = Parameters<GraphTokenReader>[0];

const LIGHT_CANVAS = { '--background': '#ffffff', '--foreground': '#111111' } as const;
const DARK_CANVAS = { '--background': '#181818', '--foreground': '#fafafa' } as const;

const ROLE_TOKENS = {
  '--muted-foreground': '#525252',
  '--primary': '#1d4ed8',
  '--success': '#15803d',
  '--warning': '#a16207',
  '--destructive': '#b91c1c',
  '--chart-1': '#1e40af',
  '--chart-2': '#166534',
  '--chart-3': '#854d0e',
  '--chart-4': '#6b21a8',
  '--chart-5': '#9f1239',
  '--identity-2': '#0e7490',
  '--identity-3': '#c2410c',
  '--identity-4': '#be185d',
} as const;

function readerOf(colors: Partial<Record<Token, string | null>>): GraphTokenReader {
  return (token) => {
    const color = colors[token] ?? null;
    return color === null ? null : `${color}ff`;
  };
}

function roleColors(palette: GraphPalette): string[] {
  return [
    palette.foreground,
    palette.muted,
    palette.primary,
    palette.success,
    palette.warning,
    palette.destructive,
    palette.folder,
    ...palette.clusters,
  ];
}

function opaque(color: string): string {
  expect(color).toMatch(/^#[0-9a-f]{6}(ff)?$/i);
  return color.slice(0, 7);
}

describe('graphPaletteFrom', () => {
  test('gives each role the color of its own token', () => {
    expect(
      graphPaletteFrom(
        readerOf({ ...LIGHT_CANVAS, ...ROLE_TOKENS }),
        fallbackGraphPalette('light'),
      ),
    ).toEqual({
      background: '#ffffffff',
      foreground: '#111111ff',
      muted: '#525252',
      primary: '#1d4ed8',
      success: '#15803d',
      warning: '#a16207',
      destructive: '#b91c1c',
      folder: '#6b21a8',
      clusters: [
        '#1e40af',
        '#166534',
        '#854d0e',
        '#6b21a8',
        '#9f1239',
        '#0e7490',
        '#c2410c',
        '#be185d',
      ],
    });
  });

  test('draws every node and label color at 3:1 or more on the canvas', () => {
    const palette = graphPaletteFrom(
      (token) =>
        token === '--background'
          ? '#ffffffff'
          : token === '--foreground'
            ? '#111111ff'
            : '#a5f3fcff',
      fallbackGraphPalette('light'),
    );
    expect(palette.clusters).toHaveLength(8);
    for (const color of roleColors(palette)) {
      expect(contrastRatio(opaque(color), '#ffffff'), color).toBeGreaterThanOrEqual(3);
    }
  });

  test('lifts faint tokens toward the text color until they reach 3:1 on a dark canvas', () => {
    const faint = '#2a2f45';
    const palette = graphPaletteFrom(
      (token) =>
        token === '--background'
          ? '#111111ff'
          : token === '--foreground'
            ? '#f5f5f5ff'
            : `${faint}ff`,
      fallbackGraphPalette('dark'),
    );
    for (const color of roleColors(palette)) {
      expect(contrastRatio(opaque(color), '#111111'), color).toBeGreaterThanOrEqual(3);
      expect(relativeLuminance(opaque(color)), color).toBeGreaterThan(relativeLuminance(faint));
    }
  });

  test('keeps the previous color of a token that fails to resolve', () => {
    const previous = graphPaletteFrom(
      readerOf({ ...LIGHT_CANVAS, ...ROLE_TOKENS }),
      fallbackGraphPalette('light'),
    );
    const unresolved = new Set<Token>([
      '--muted-foreground',
      '--primary',
      '--success',
      '--warning',
      '--destructive',
      '--chart-2',
      '--chart-4',
    ]);
    const next = graphPaletteFrom(
      (token) =>
        token === '--background'
          ? '#ffffffff'
          : token === '--foreground'
            ? '#111111ff'
            : unresolved.has(token)
              ? null
              : '#7c2d12ff',
      previous,
    );
    expect(next).toEqual({
      background: '#ffffffff',
      foreground: '#111111ff',
      muted: '#525252',
      primary: '#1d4ed8',
      success: '#15803d',
      warning: '#a16207',
      destructive: '#b91c1c',
      folder: '#6b21a8',
      clusters: [
        '#7c2d12',
        '#166534',
        '#7c2d12',
        '#6b21a8',
        '#7c2d12',
        '#7c2d12',
        '#7c2d12',
        '#7c2d12',
      ],
    });
  });

  test('holds a kept color to 3:1 when the canvas changes under it', () => {
    const previous = graphPaletteFrom(
      readerOf({ ...LIGHT_CANVAS, ...ROLE_TOKENS }),
      fallbackGraphPalette('light'),
    );
    const next = graphPaletteFrom(
      (token) =>
        token === '--background'
          ? '#181818ff'
          : token === '--foreground'
            ? '#fafafaff'
            : token === '--primary' || token === '--chart-2'
              ? null
              : '#93c5fdff',
      previous,
    );
    expect(next.background).toBe('#181818ff');
    for (const color of roleColors(next)) {
      expect(contrastRatio(opaque(color), '#181818'), color).toBeGreaterThanOrEqual(3);
    }
  });

  test('keeps the canvas pair when only one of background and foreground resolves', () => {
    const previous = graphPaletteFrom(
      readerOf({ ...LIGHT_CANVAS, ...ROLE_TOKENS }),
      fallbackGraphPalette('light'),
    );
    for (const canvas of [{ '--background': '#181818' }, { '--foreground': '#fafafa' }]) {
      const next = graphPaletteFrom(readerOf({ ...canvas, ...ROLE_TOKENS }), previous);
      expect(next.background).toBe(previous.background);
      expect(next.foreground).toBe(previous.foreground);
    }
  });

  test('holds fallback colors to 3:1 on a canvas the first read resolves', () => {
    const palette = graphPaletteFrom(readerOf(DARK_CANVAS), fallbackGraphPalette('light'));
    expect(palette.background).toBe('#181818ff');
    for (const color of roleColors(palette)) {
      expect(contrastRatio(opaque(color), '#181818'), color).toBeGreaterThanOrEqual(3);
    }
  });

  test.each(['light', 'dark'] as const)(
    'draws visible colors in %s mode when no token resolves on the first read',
    (mode) => {
      const palette = graphPaletteFrom(() => null, fallbackGraphPalette(mode));
      for (const color of roleColors(palette)) {
        expect(
          contrastRatio(opaque(color), opaque(palette.background)),
          color,
        ).toBeGreaterThanOrEqual(3);
      }
    },
  );
});
