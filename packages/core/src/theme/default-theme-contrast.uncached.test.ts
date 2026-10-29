import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clampRgb, parse, type Rgb, rgb, wcagContrast } from 'culori';
import { describe, expect, test } from 'vitest';
import { findBlockBodies, resolveChromeTokensFromCss } from '../../scripts/chrome-resolver.ts';

const GLOBALS_CSS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../app/src/globals.css',
);

function declarations(css: string, selector: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const body of findBlockBodies(css, selector)) {
    for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      if (name !== undefined && value !== undefined) map.set(name, value.trim());
    }
  }
  return map;
}

function color(value: string | undefined): Rgb {
  const parsed = value === undefined ? undefined : parse(value);
  if (parsed === undefined) throw new Error(`not a color literal: ${value}`);
  return clampRgb(rgb(parsed));
}

function tint(surface: Rgb, over: Rgb, amount: number): Rgb {
  return {
    mode: 'rgb',
    r: surface.r + (over.r - surface.r) * amount,
    g: surface.g + (over.g - surface.g) * amount,
    b: surface.b + (over.b - surface.b) * amount,
  };
}

describe('default theme status tokens', () => {
  const css = readFileSync(GLOBALS_CSS, 'utf8');
  const light = declarations(css, ':root');
  const dark = new Map([...light, ...declarations(css, '.dark')]);

  for (const [mode, tokens] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    test(`${mode}: success, warning, info and destructive read on the page, cards, popovers and a 20% tint of themselves`, () => {
      for (const status of ['--success', '--warning', '--info', '--destructive']) {
        const text = color(tokens.get(status));
        for (const surfaceName of ['--background', '--card', '--popover']) {
          const surface = color(tokens.get(surfaceName));
          expect(wcagContrast(surface, text), `${status} on ${surfaceName}`).toBeGreaterThanOrEqual(
            4.5,
          );
          expect(
            wcagContrast(tint(surface, text, 0.2), text),
            `${status} on its 20% tint over ${surfaceName}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }
});

const SHADCN_FOCUS_RING_OPACITY = 0.5;

describe('default theme focus ring and muted text', () => {
  const css = readFileSync(GLOBALS_CSS, 'utf8');
  const light = declarations(css, ':root');
  const dark = new Map([...light, ...declarations(css, '.dark')]);
  const chrome = resolveChromeTokensFromCss(GLOBALS_CSS);

  for (const [mode, tokens, desk] of [
    ['light', light, chrome.light],
    ['dark', dark, chrome.dark],
  ] as const) {
    const surfaces: [string, Rgb][] = [
      ...[
        '--background',
        '--card',
        '--popover',
        '--muted',
        '--secondary',
        '--accent',
        '--sidebar',
      ].map((name): [string, Rgb] => [name, color(tokens.get(name))]),
      ['--desk', color(desk)],
    ];

    test(`${mode}: muted text reaches 4.5:1 on the default surface tokens`, () => {
      const text = color(tokens.get('--muted-foreground'));
      for (const [name, surface] of surfaces) {
        expect(wcagContrast(text, surface), `--muted-foreground on ${name}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    });

    test(`${mode}: the half-opacity ring reaches 3:1 over the default surface tokens`, () => {
      const ring = color(tokens.get('--ring'));
      for (const [name, surface] of surfaces) {
        expect(
          wcagContrast(tint(surface, ring, SHADCN_FOCUS_RING_OPACITY), surface),
          `--ring at ${SHADCN_FOCUS_RING_OPACITY} over ${name}`,
        ).toBeGreaterThanOrEqual(3);
      }
    });
  }
});
