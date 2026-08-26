/**
 * WCAG non-text contrast gate for the comment-highlight hue.
 *
 * The highlight is a graphical indicator — it is what says "someone commented
 * on these words" — so it owes WCAG 2.x 1.4.11's 3:1 floor against the canvas
 * behind it, the same bar the chart palette is held to in
 * `preview-theme-tokens.test.ts`. The underline carries that signal: the fill
 * is a faint tint by design and does not clear 3:1 on its own at either end.
 *
 * This is also the only pin on the hue's actual value. `anchor-layers.test.ts`
 * derives its expected styles from the constant so it asserts the intensity
 * ladder rather than the colour, which leaves a miscoded hue free to pass
 * everywhere else. A number that fails here is either a bad hue or an alpha
 * ladder that has drifted, and both are worth stopping.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const GLOBALS_CSS = resolve(dirname(fileURLToPath(import.meta.url)), '../globals.css');

/** WCAG 2.x 1.4.11 — graphical objects, as opposed to text's 4.5:1. */
const MIN_NONTEXT_CONTRAST = 3;

/**
 * The resting underline's alpha, from `anchor-layers.ts`. Resting rather than
 * active because it is the weaker of the two — an unattended comment is the
 * state a reader has to notice unprompted.
 */
const RESTING_LINE_ALPHA = 0.7;

/**
 * The canvases, resolved from `--background`. Held as literals because
 * converting oklch in-test would mean pulling a colour library into
 * `packages/app` for one assertion; `canvas declarations are unchanged` below
 * fails loudly if either token moves, which is the point at which these need
 * recomputing.
 */
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

/** Flatten a translucent mark onto the opaque canvas behind it. */
function composite(fg: Rgb, alpha: number, bg: Rgb): number[] {
  return [0, 1, 2].map((i) => alpha * fg[i] + (1 - alpha) * bg[i]);
}

const css = readFileSync(GLOBALS_CSS, 'utf8');

/**
 * Both declarations of one custom property, in source order. `:root` is
 * authored before `.dark` in `globals.css`, so the first is light.
 */
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
    // Guards the literals in CANVASES. If this fails, --background moved and
    // the ratios below are being measured against the wrong ground.
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
    // Not cosmetic: a single hue across both canvases is exactly the state that
    // failed — one blue cannot clear the floor on white and on near-black.
    const [light, dark] = declarations('--ok-comment-hue');
    expect(light).not.toBe(dark);
  });
});
