import { FALLBACK_LOCALE } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { dynamicActivate } from './activate-locale';
import { i18n } from './i18n';

/**
 * Separate file on purpose. Which catalogs are already in memory is
 * module-level state, and vitest gives each file its own module registry — so
 * this is the only way to keep a locale genuinely un-fetched while the
 * assertion runs. Sharing a file with the other suite would silently reduce
 * this to two synchronous calls and prove nothing.
 */
describe('dynamicActivate with overlapping calls', () => {
  test('lands on the last requested locale even when an earlier load finishes after it', async () => {
    // `zh-Hant` has to be fetched, so its call suspends. The bootstrap locale
    // is already in memory, so its call activates and returns before the fetch
    // resolves — the interleaving a user gets by clicking through the picker
    // faster than the network answers.
    const superseded = dynamicActivate('zh-Hant');
    const latest = dynamicActivate(FALLBACK_LOCALE);
    await Promise.all([superseded, latest]);

    expect(i18n.locale).toBe(FALLBACK_LOCALE);
  });
});
