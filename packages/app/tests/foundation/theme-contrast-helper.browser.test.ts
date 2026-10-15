import { expect, test } from 'vitest';
import { rgba } from './theme-contrast.test-helper';

test.each([
  { css: '#3e4b59', expected: [62 / 255, 75 / 255, 89 / 255, 1] },
  { css: '#808e80', expected: [128 / 255, 142 / 255, 128 / 255, 1] },
])('contrast measurements preserve hexadecimal $css', ({ css, expected }) => {
  expect(rgba(css)).toEqual(expected);
});

test('contrast measurements accept scientific channels in functional colors', () => {
  expect(rgba('color(srgb 4e-3 5e-2 0.5 / 1)')).toEqual([0.004, 0.05, 0.5, 1]);
});

test('contrast measurements preserve ordinary rendered RGB colors', () => {
  expect(rgba('rgb(62, 75, 89)')).toEqual([62 / 255, 75 / 255, 89 / 255, 1]);
});

test('contrast measurements reject unsupported colors', () => {
  expect(() => rgba('var(--foreground)')).toThrow();
});
