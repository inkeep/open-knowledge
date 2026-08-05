/**
 * Pins `packages/app/lingui.config.ts`'s locale list to core's
 * `SUPPORTED_LOCALES`.
 *
 * The two lists cannot be one declaration: the Lingui CLI loads its config
 * through its own TS loader ahead of any workspace build, so importing core
 * there would make catalog extraction depend on core's build output. This test
 * is what keeps them from drifting instead. Drift in either direction is a real
 * user-visible defect — a locale the config accepts with no catalog behind it
 * means someone picks a language and gets English, and a catalog nothing can
 * select is dead weight that still costs a translation on every new string.
 *
 * Lives in `tests/meta/` (run by `test:integration`) alongside the other
 * i18n-substrate contract tests.
 */
import { PICKER_LOCALES, SUPPORTED_LOCALES } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import linguiConfig from '../../lingui.config';

const configured = linguiConfig.locales;
const pseudo = linguiConfig.pseudoLocale;

describe('lingui config locale list', () => {
  test('carries the generated pseudolocale, which is not a supported language', () => {
    expect(configured).toContain(pseudo);
    expect(SUPPORTED_LOCALES).not.toContain(pseudo);
    // Nor an offerable one. Marked-up English is a verification instrument, and
    // a picker entry is a promise that someone can read what comes back.
    expect(PICKER_LOCALES).not.toContain(pseudo);
  });

  test('is exactly SUPPORTED_LOCALES plus the pseudolocale', () => {
    const translatable = configured.filter((locale) => locale !== pseudo);
    const enumerated = new Set<string>(SUPPORTED_LOCALES);

    expect({
      missingFromConfig: SUPPORTED_LOCALES.filter((locale) => !translatable.includes(locale)),
      extraInConfig: translatable.filter((locale) => !enumerated.has(locale)),
    }).toEqual({ missingFromConfig: [], extraInConfig: [] });
  });

  test('the source locale is the one every other catalog is translated from', () => {
    expect(linguiConfig.sourceLocale).toBe('en');
    expect(SUPPORTED_LOCALES).toContain('en');
  });
});
