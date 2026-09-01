import { FALLBACK_LOCALE, SUPPORTED_LOCALES } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test } from 'vitest';
import { dynamicActivate } from './activate-locale';
import { i18n } from './i18n';

afterEach(async () => {
  await dynamicActivate(FALLBACK_LOCALE);
});

describe('dynamicActivate', () => {
  test('activates a locale that was not part of the bootstrap', async () => {
    await dynamicActivate('zh-Hans');

    expect(i18n.locale).toBe('zh-Hans');
    expect(Object.keys(i18n.messages).length).toBeGreaterThan(0);
  });

  test('returns to the bootstrap locale with its catalog intact', async () => {
    const bootstrapMessageCount = Object.keys(i18n.messages).length;

    await dynamicActivate('es');
    await dynamicActivate(FALLBACK_LOCALE);

    expect(i18n.locale).toBe(FALLBACK_LOCALE);
    expect(Object.keys(i18n.messages)).toHaveLength(bootstrapMessageCount);
  });

  test.each(SUPPORTED_LOCALES)('loads a non-empty catalog for %s', async (locale) => {
    await dynamicActivate(locale);

    expect(i18n.locale).toBe(locale);
    expect(Object.keys(i18n.messages).length).toBeGreaterThan(0);
  });
});
