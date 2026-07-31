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
    // One decimal below ten of a unit, none above — so a six-figure count stays
    // three digits wide rather than reading `589.4K`.
    [589_400, '589K'],
    [718_007, '718K'],
    [999_500, '1M'],
    [1_000_000, '1M'],
    [2_732_691, '2.7M'],
    [27_000_000, '27M'],
  ])('%i renders as %s', (input, expected) => {
    expect(formatInstalls(input, 'en-US')).toBe(expected);
  });

  // The regression this replaced scaled by a fixed 1000 divisor, so a count in
  // the millions read "2733k". Compact notation promotes the unit instead — no
  // count renders more than three digits ahead of its suffix.
  test('promotes past thousands instead of overflowing the unit', () => {
    expect(formatInstalls(2_732_691, 'en-US')).not.toContain('K');
    expect(formatInstalls(27_000_000, 'en-US')).toBe('27M');
  });

  // Locale-correctness is the reason for delegating to Intl rather than
  // hand-scaling: the unit name, its abbreviation, and the decimal separator all
  // differ, and every user-facing string in this app is localized.
  // Asserted by shape rather than exact bytes: CLDR joins the unit with a
  // non-breaking space, and both the spelling and the scale it picks can shift
  // between ICU versions. What must hold is that the unit and the decimal
  // separator are the locale's, not en-US's.
  test('honors the active locale', () => {
    const de = formatInstalls(2_732_691, 'de-DE');
    expect(de).toContain('2,7');
    expect(de).toContain('Mio.');
    // ja-JP counts in 万 (ten-thousands), not thousands/millions.
    expect(formatInstalls(2_732_691, 'ja-JP')).toContain('万');
  });

  // The two locale values a row can actually be handed: '' before the Lingui
  // catalog activates (`new Intl.NumberFormat('')` throws RangeError, which would
  // take out the card), and 'pseudo', this app's second catalog — a well-formed
  // language subtag ICU resolves by fallback rather than rejecting.
  test.each([[''], ['pseudo']])('formats rather than throwing on locale %o', (locale) => {
    expect(() => formatInstalls(2_732_691, locale)).not.toThrow();
    expect(formatInstalls(2_732_691, locale)).not.toBe('');
  });
});
