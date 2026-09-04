import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  PREVIEW_TOKEN_NAMES,
  renderPreviewThemeTokensModule,
  resolvePreviewThemeTokensFromCss,
  wcagContrast,
} from '../../scripts/preview-theme-token-resolver.ts';
import { PREVIEW_THEME_TOKENS } from './preview-theme-tokens.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const GLOBALS_CSS = resolve(HERE, '../../../app/src/globals.css');

const MIN_NONTEXT_CONTRAST = 3;

const MIN_HUE_SEPARATION_DEG = 25;

function tokenByName(name: string): { name: string; light: string; dark: string } {
  const t = PREVIEW_THEME_TOKENS.find((x) => x.name === name);
  if (!t) throw new Error(`preview-theme-tokens.test: missing token ${name}`);
  return t;
}

function oklchHue(value: string): number {
  const m = value.match(/^oklch\(\s*[\d.]+\s+[\d.]+\s+([\d.]+)/);
  if (!m) throw new Error(`preview-theme-tokens.test: not an oklch literal: ${value}`);
  return Number(m[1]);
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

const CHART_TOKENS = PREVIEW_THEME_TOKENS.filter((t) => t.name.startsWith('--chart-'));
const BG_LIGHT = tokenByName('--background').light;
const BG_DARK = tokenByName('--background').dark;

describe('preview-theme-tokens — drift check', () => {
  const resolved = resolvePreviewThemeTokensFromCss(GLOBALS_CSS);

  test('PREVIEW_THEME_TOKENS values match the resolved globals.css tokens', () => {
    expect(PREVIEW_THEME_TOKENS).toEqual(resolved);
  });

  test('renderPreviewThemeTokensModule emits the constant for the resolved tokens', () => {
    const body = renderPreviewThemeTokensModule(resolved);
    expect(body).toContain('export const PREVIEW_THEME_TOKENS');
    for (const t of resolved) {
      expect(body).toContain(`name: '${t.name}'`);
    }
  });
});

describe('preview-theme-tokens — token subset coverage', () => {
  test('covers exactly the injected token subset, in declared order', () => {
    expect(PREVIEW_THEME_TOKENS.map((t) => t.name)).toEqual([...PREVIEW_TOKEN_NAMES]);
  });

  test('every value is a resolved literal — no var() indirection survives', () => {
    for (const t of PREVIEW_THEME_TOKENS) {
      expect(t.light).not.toContain('var(');
      expect(t.dark).not.toContain('var(');
    }
  });
});

describe('chart palette — WCAG-AA non-text contrast', () => {
  test('the five chart tokens are present', () => {
    expect(CHART_TOKENS.map((t) => t.name)).toEqual([
      '--chart-1',
      '--chart-2',
      '--chart-3',
      '--chart-4',
      '--chart-5',
    ]);
  });

  for (const t of CHART_TOKENS) {
    test(`${t.name} light value clears ${MIN_NONTEXT_CONTRAST}:1 on the light background`, () => {
      expect(wcagContrast(t.light, BG_LIGHT)).toBeGreaterThanOrEqual(MIN_NONTEXT_CONTRAST);
    });

    test(`${t.name} dark value clears ${MIN_NONTEXT_CONTRAST}:1 on the dark background`, () => {
      expect(wcagContrast(t.dark, BG_DARK)).toBeGreaterThanOrEqual(MIN_NONTEXT_CONTRAST);
    });
  }
});

describe('chart palette — perceptually distinct hues', () => {
  function expectPairwiseDistinct(hues: number[]): void {
    for (let i = 0; i < hues.length; i++) {
      for (let j = i + 1; j < hues.length; j++) {
        expect(hueDistance(hues[i], hues[j])).toBeGreaterThanOrEqual(MIN_HUE_SEPARATION_DEG);
      }
    }
  }

  test(`light hues are pairwise ≥ ${MIN_HUE_SEPARATION_DEG}° apart`, () => {
    expectPairwiseDistinct(CHART_TOKENS.map((t) => oklchHue(t.light)));
  });

  test(`dark hues are pairwise ≥ ${MIN_HUE_SEPARATION_DEG}° apart`, () => {
    expectPairwiseDistinct(CHART_TOKENS.map((t) => oklchHue(t.dark)));
  });
});
