import { describe, expect, test } from 'vitest';
import { readGlobalsCssWithoutComments } from './globals-css.test-helper';

const CSS = readGlobalsCssWithoutComments();

function markerDeclarations(): string {
  const block = CSS.match(/(?:^|[}\s])\.ok-pointer-marker\s*\{([^{}]*)\}/);
  return block?.[1] ?? '';
}

describe('globals.css — .ok-pointer-marker', () => {
  test('the rule exists (guard is not vacuous)', () => {
    expect(markerDeclarations().trim().length).toBeGreaterThan(0);
  });

  test('is viewport-positioned, so the injected inline left/top are pointer coordinates', () => {
    expect(markerDeclarations()).toMatch(/position\s*:\s*fixed/);
  });

  test('centres itself on those coordinates', () => {
    expect(markerDeclarations()).toMatch(/transform\s*:\s*translate\(\s*-50%\s*,\s*-50%\s*\)/);
  });

  test('out-stacks every layer in the app', () => {
    const zIndex = markerDeclarations().match(/z-index\s*:\s*(\d+)/);
    expect(zIndex, 'z-index declaration must be present').not.toBeNull();
    expect(Number(zIndex?.[1])).toBe(2147483647);
  });

  test('keeps both of its visual channels under forced colors', () => {
    expect(markerDeclarations()).toMatch(/forced-color-adjust\s*:\s*none/);
  });

  test('does not intercept input while it is on screen', () => {
    expect(markerDeclarations()).toMatch(/pointer-events\s*:\s*none/);
  });

  test('draws a hollow ring rather than a filled dot', () => {
    expect(markerDeclarations()).toMatch(/border\s*:\s*[^;]*solid/);
    expect(markerDeclarations()).toMatch(/border-radius\s*:\s*50%/);
    expect(markerDeclarations()).toMatch(/background\s*:\s*transparent/);
  });
});
