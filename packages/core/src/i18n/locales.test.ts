import { describe, expect, test } from 'vitest';
import { localeDirection } from './direction.ts';
import {
  AUTO_DETECTABLE_LOCALES,
  LAYOUT_DEFERRED_LOCALES,
  PICKER_LOCALES,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from './locales.ts';

// Independent oracle for the negotiation key: canonicalize, add likely
// subtags, keep language + script. The matcher derives the same key, so this
// deliberately recomputes it from `Intl` rather than importing it — a shared
// helper would let a broken reduction agree with itself.
function reducedKey(tag: SupportedLocale): string {
  const canonical = Intl.getCanonicalLocales(tag)[0];
  if (canonical === undefined) throw new Error(`not a locale: ${tag}`);
  const max = new Intl.Locale(canonical).maximize();
  return `${max.language}-${max.script}`;
}

describe('SUPPORTED_LOCALES', () => {
  test('every tag is already in canonical BCP 47 form', () => {
    const nonCanonical = SUPPORTED_LOCALES.filter(
      (tag) => Intl.getCanonicalLocales(tag)[0] !== tag,
    );
    expect(nonCanonical).toEqual([]);
  });

  // A collision (adding bare `pt` beside `pt-BR`, say — both reduce to
  // `pt-Latn`) would make negotiation resolve to whichever entry the matcher
  // happened to scan first, which is silent and order-dependent.
  test('no two locales share a reduced language-Script key', () => {
    const keys = SUPPORTED_LOCALES.map(reducedKey);
    expect(new Set(keys).size).toBe(SUPPORTED_LOCALES.length);
  });
});

describe('PICKER_LOCALES', () => {
  test('offers only enumerated locales, and not all of them', () => {
    const enumerated = new Set<string>(SUPPORTED_LOCALES);
    expect(PICKER_LOCALES.filter((tag) => !enumerated.has(tag))).toEqual([]);
    expect(PICKER_LOCALES.length).toBeLessThan(SUPPORTED_LOCALES.length);
  });
});

describe('LAYOUT_DEFERRED_LOCALES', () => {
  // The reason these two are held back is that the chrome does not lay out
  // right-to-left yet. Pinning the direction here is what keeps the list from
  // being read as a general quality gate and quietly growing into one.
  test('holds back exactly the right-to-left locales', () => {
    const rightToLeft = SUPPORTED_LOCALES.filter((tag) => localeDirection(tag) === 'rtl');
    expect([...LAYOUT_DEFERRED_LOCALES]).toEqual(rightToLeft);
  });

  test('they stay enumerated, and stay out of the picker', () => {
    const enumerated = new Set<string>(SUPPORTED_LOCALES);
    expect(LAYOUT_DEFERRED_LOCALES.filter((tag) => !enumerated.has(tag))).toEqual([]);
    const offered = new Set<string>(PICKER_LOCALES);
    expect(LAYOUT_DEFERRED_LOCALES.filter((tag) => offered.has(tag))).toEqual([]);
  });
});

describe('AUTO_DETECTABLE_LOCALES', () => {
  test('is the enumerated set minus the ones whose layout is unfinished', () => {
    const held = new Set<string>(LAYOUT_DEFERRED_LOCALES);
    expect(AUTO_DETECTABLE_LOCALES).toEqual(SUPPORTED_LOCALES.filter((tag) => !held.has(tag)));
  });

  // Order is the tie-break rule the matcher walks, so it has to survive the
  // filter rather than being rebuilt in some other order.
  test('keeps the enumerated order', () => {
    const positions = AUTO_DETECTABLE_LOCALES.map((tag) => SUPPORTED_LOCALES.indexOf(tag));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});
