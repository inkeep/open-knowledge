/**
 * The pseudolocale, reachable during development as `?lang=pseudo`.
 *
 * `lingui extract` generates it from `en` by swapping every Latin letter for an
 * accented lookalike, so activating it marks every string that goes through the
 * catalog and leaves everything else in plain ASCII. That is what separates the
 * two ways a string can turn up in English during a coverage sweep: still plain
 * means nobody wrapped it, marked-but-English means it is wrapped and the
 * catalog entry is empty. No other instrument tells those apart.
 *
 * It is not a language. It is absent from the supported set and from the
 * picker, it cannot be stored as a preference, and activating it writes nothing
 * — so the next load without the query parameter is back to the configured
 * language with no trace left behind.
 *
 * Both exports below check for a production build, and the two checks do
 * different jobs. The one in `isPseudoLocaleRequested` keeps the behaviour
 * unreachable, so a production build that is handed the query parameter takes
 * the ordinary configured-language path rather than quietly having no language
 * at all. The one in `activatePseudoLocale` keeps the catalog — larger than
 * `en`, since accented characters cost more bytes — out of the shipped build:
 * Vite replaces `import.meta.env.PROD` with a literal, which makes the import
 * below it dead code and the chunk is never emitted.
 * `tests/meta/locale-catalog-chunks.test.ts` measures both halves on a real
 * build in both modes, so neither is taken on trust.
 */

import type { Messages } from '@lingui/core';
import { i18n } from './i18n';

const PSEUDO_LOCALE = 'pseudo';

/**
 * Whether this session asked for the pseudolocale.
 *
 * Only the pseudolocale answers to this parameter. Every real language is
 * already reachable as a preference that persists and follows the user across
 * surfaces, which is what a language wants; a verification instrument wants the
 * opposite, and gets it from a parameter that survives exactly one load.
 */
export function isPseudoLocaleRequested(): boolean {
  if (import.meta.env.PROD === true) return false;
  return new URLSearchParams(window.location.search).get('lang') === PSEUDO_LOCALE;
}

/** Load the pseudolocalized catalog and make it the active one. */
export async function activatePseudoLocale(): Promise<void> {
  if (import.meta.env.PROD === true) return;

  const { default: catalog } = await import('@/locales/pseudo/messages.json');
  i18n.load(PSEUDO_LOCALE, catalog.messages as unknown as Messages);
  i18n.activate(PSEUDO_LOCALE);
}
