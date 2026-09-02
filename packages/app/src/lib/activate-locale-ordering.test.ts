import { FALLBACK_LOCALE } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { dynamicActivate } from './activate-locale';
import { i18n } from './i18n';

describe('dynamicActivate with overlapping calls', () => {
  test('lands on the last requested locale even when an earlier load finishes after it', async () => {
    const superseded = dynamicActivate('zh-Hant');
    const latest = dynamicActivate(FALLBACK_LOCALE);
    await Promise.all([superseded, latest]);

    expect(i18n.locale).toBe(FALLBACK_LOCALE);
  });
});
