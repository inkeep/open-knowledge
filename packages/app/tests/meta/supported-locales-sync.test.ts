import { PICKER_LOCALES, SUPPORTED_LOCALES } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import linguiConfig from '../../lingui.config';
import appPackage from '../../package.json';

const configured = linguiConfig.locales;
const pseudo = linguiConfig.pseudoLocale;
const extractScript = appPackage.scripts['i18n:extract'];

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

  test('i18n:extract writes a catalog for every supported locale and none for the pseudolocale', () => {
    const listed = /--locale[ =](\S+)/.exec(extractScript ?? '')?.[1]?.split(',') ?? [];
    expect(
      { listed: [...listed].sort(), pseudoListed: listed.includes(pseudo as string) },
      `packages/app/package.json "i18n:extract" must pass --locale with exactly SUPPORTED_LOCALES (packages/core/src/i18n/locales.ts), which lingui.config.ts also lists. A locale missing from --locale keeps a stale catalog, and listing the pseudolocale writes a catalog that compile already derives from en.`,
    ).toEqual({ listed: [...SUPPORTED_LOCALES].sort(), pseudoListed: false });
  });

  test('the source locale is the one every other catalog is translated from', () => {
    expect(linguiConfig.sourceLocale).toBe('en');
    expect(SUPPORTED_LOCALES).toContain('en');
  });
});
