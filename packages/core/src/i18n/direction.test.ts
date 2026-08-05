import { afterEach, describe, expect, test } from 'vitest';
import { localeDirection } from './direction.ts';
import { SUPPORTED_LOCALES } from './locales.ts';

const RIGHT_TO_LEFT = ['ar', 'ur'] as const;

let restorePrototype: (() => void) | null = null;

/**
 * Run `body` on a runtime that has no `getTextInfo`, which is what every
 * browser below the support floor looks like.
 *
 * The method is deleted rather than stubbed with `undefined`: deletion is the
 * only shape that reproduces an engine which never shipped the API, and it is
 * what the optional call in `localeDirection` actually branches on.
 */
function withoutTextInfo<T>(body: () => T): T {
  const proto = Intl.Locale.prototype;
  const previous = Object.getOwnPropertyDescriptor(proto, 'getTextInfo');
  if (previous === undefined)
    throw new Error('getTextInfo is already absent — test proves nothing');
  Reflect.deleteProperty(proto, 'getTextInfo');
  restorePrototype = () => Object.defineProperty(proto, 'getTextInfo', previous);
  try {
    return body();
  } finally {
    restorePrototype();
    restorePrototype = null;
  }
}

afterEach(() => {
  restorePrototype?.();
  restorePrototype = null;
});

describe('localeDirection', () => {
  test.each(SUPPORTED_LOCALES)('%s reads the same way on both paths', (locale) => {
    const expected = (RIGHT_TO_LEFT as readonly string[]).includes(locale) ? 'rtl' : 'ltr';

    // Asserting the two paths against one literal rather than against each
    // other: comparing them would pass just as happily if both were wrong.
    expect(localeDirection(locale)).toBe(expected);
    expect(withoutTextInfo(() => localeDirection(locale))).toBe(expected);
  });

  test('a platform answer outside the two known values is not trusted', () => {
    const proto = Intl.Locale.prototype;
    const previous = Object.getOwnPropertyDescriptor(proto, 'getTextInfo');
    if (previous === undefined) throw new Error('getTextInfo is absent — test proves nothing');
    Object.defineProperty(proto, 'getTextInfo', {
      ...previous,
      value: () => ({ direction: 'auto' }),
    });
    restorePrototype = () => Object.defineProperty(proto, 'getTextInfo', previous);

    // `auto` is a real `dir` value and a meaningless answer for a locale, so a
    // runtime reporting it has to fall through rather than be passed along.
    expect(localeDirection('ar')).toBe('rtl');
    expect(localeDirection('en')).toBe('ltr');
  });
});
