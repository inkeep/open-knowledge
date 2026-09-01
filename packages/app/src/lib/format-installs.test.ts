import { describe, expect, test } from 'vitest';
import { formatInstalls } from './format-installs';

describe('formatInstalls', () => {
  test.each([
    [0, '0'],
    [7, '7'],
    [999, '999'],
    [1000, '1K'],
    [1200, '1.2K'],
    [9949, '9.9K'],
    [10_000, '10K'],
    [589_400, '589K'],
    [718_007, '718K'],
    [999_500, '1M'],
    [1_000_000, '1M'],
    [2_732_691, '2.7M'],
    [27_000_000, '27M'],
  ])('%i renders as %s', (input, expected) => {
    expect(formatInstalls(input, 'en-US')).toBe(expected);
  });

  test('promotes past thousands instead of overflowing the unit', () => {
    expect(formatInstalls(2_732_691, 'en-US')).not.toContain('K');
    expect(formatInstalls(27_000_000, 'en-US')).toBe('27M');
  });

  test('honors the active locale', () => {
    const de = formatInstalls(2_732_691, 'de-DE');
    expect(de).toContain('2,7');
    expect(de).toContain('Mio.');
    expect(formatInstalls(2_732_691, 'ja-JP')).toContain('万');
  });

  test.each([[''], ['pseudo']])('formats rather than throwing on locale %o', (locale) => {
    expect(() => formatInstalls(2_732_691, locale)).not.toThrow();
    expect(formatInstalls(2_732_691, locale)).not.toBe('');
  });
});
