import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const GLOBALS_CSS = resolve(dirname(fileURLToPath(import.meta.url)), '../globals.css');

const MIN_NONTEXT_CONTRAST = 3;

const RESTING_LINE_ALPHA = 0.7;

const CANVASES = {
  light: { rgb: [255, 255, 255], decl: 'oklch(1 0 0)' },
  dark: { rgb: [10, 10, 10], decl: 'oklch(0.145 0 0)' },
} as const;

type Rgb = readonly [number, number, number] | number[];

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function composite(fg: Rgb, alpha: number, bg: Rgb): number[] {
  return [0, 1, 2].map((i) => alpha * fg[i] + (1 - alpha) * bg[i]);
}

const css = readFileSync(GLOBALS_CSS, 'utf8');

function declarations(name: string): string[] {
  return [...css.matchAll(new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'gm'))].map((m) => m[1].trim());
}

function hue(declaration: string): number[] {
  const parts = declaration.split(',').map((p) => Number(p.trim()));
  expect(parts).toHaveLength(3);
  for (const part of parts) expect(Number.isFinite(part)).toBe(true);
  return parts;
}

describe('comment highlight hue', () => {
  test('canvas declarations are unchanged', () => {
    const backgrounds = declarations('--background');
    expect(backgrounds[0]).toBe(CANVASES.light.decl);
    expect(backgrounds[1]).toBe(CANVASES.dark.decl);
  });

  test('is declared once per theme', () => {
    expect(declarations('--ok-comment-hue')).toHaveLength(2);
  });

  test.each([
    ['light', 0],
    ['dark', 1],
  ] as const)('resting underline clears 3:1 on the %s canvas', (theme, index) => {
    const canvas = CANVASES[theme].rgb;
    const line = composite(
      hue(declarations('--ok-comment-hue')[index]),
      RESTING_LINE_ALPHA,
      canvas,
    );
    expect(contrast(line, canvas)).toBeGreaterThanOrEqual(MIN_NONTEXT_CONTRAST);
  });

  test('the two themes take different hues', () => {
    const [light, dark] = declarations('--ok-comment-hue');
    expect(light).not.toBe(dark);
  });
});
