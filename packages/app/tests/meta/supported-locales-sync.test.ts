import { PICKER_LOCALES, SUPPORTED_LOCALES } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import linguiConfig from '../../lingui.config';

const configured = linguiConfig.locales;
const pseudo = linguiConfig.pseudoLocale;

describe('lingui config locale list', () => {
  test('carries the generated pseudolocale, which is not a supported language', () => {
    expect(configured).toContain(pseudo);
    expect(SUPPORTED_LOCALES).not.toContain(pseudo);
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
