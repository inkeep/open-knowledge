/**
 * Covers the pseudolocale instrument against the real Lingui singleton and the
 * real compiled catalog, with nothing stubbed between them.
 *
 * The jsdom tier rather than the node one because the request is read off
 * `location`, and the assertions go through `i18n._` with a raw message id
 * rather than through a `t`/`<Trans>` call site: the unit configs alias the
 * Lingui macros to an English passthrough, so a macro-based assertion here
 * would be measuring the shim. A raw id is the same lookup the macros compile
 * down to and it sees the real catalog.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import enCatalog from '@/locales/en/messages.json';
import { activatePseudoLocale, isPseudoLocaleRequested } from './dev-pseudo-locale';
import { i18n } from './i18n';

/**
 * A message id whose English text is plain ASCII prose, taken from the real
 * catalog rather than written down here — the ids are content hashes, so a
 * literal one would rot the first time that string is reworded.
 */
function anAsciiProseMessage(): { id: string; english: string } {
  for (const [id, value] of Object.entries(enCatalog.messages)) {
    const [text] = value as unknown[];
    if (typeof text !== 'string') continue;
    if (!/^[\x20-\x7E]*[A-Za-z]\s[A-Za-z][\x20-\x7E]*$/.test(text)) continue;
    return { id, english: text };
  }
  throw new Error('the en catalog holds no plain-ASCII prose message to probe with');
}

const NON_ASCII = /[^\p{ASCII}]/u;

afterEach(() => {
  i18n.activate('en');
  history.replaceState(null, '', '/');
  vi.unstubAllEnvs();
});

describe('activatePseudoLocale', () => {
  test('makes the pseudolocalized catalog the one the interface renders from', async () => {
    const { id, english } = anAsciiProseMessage();
    expect(i18n._(id)).toBe(english);

    await activatePseudoLocale();

    expect(i18n.locale).toBe('pseudo');
    // Marking is the whole point: a reviewer who cannot read the language still
    // sees at a glance which strings went through the catalog and which never
    // got wrapped.
    const marked = i18n._(id);
    expect(marked).not.toBe(english);
    expect(marked).toMatch(NON_ASCII);
  });
});

describe('isPseudoLocaleRequested', () => {
  test('is asked for by name in the query string', () => {
    history.replaceState(null, '', '/?lang=pseudo');

    expect(isPseudoLocaleRequested()).toBe(true);
  });

  test('an ordinary session never lands in it', () => {
    expect(isPseudoLocaleRequested()).toBe(false);
  });

  test('the parameter answers for nothing but the pseudolocale', () => {
    // Every real language is already selectable, and a second way in that
    // outranks the saved choice for one load is a way to be confused about
    // which language the app is actually configured to speak.
    history.replaceState(null, '', '/?lang=es');

    expect(isPseudoLocaleRequested()).toBe(false);
  });

  test('a shipped build does not answer to it at all', () => {
    vi.stubEnv('PROD', true);
    history.replaceState(null, '', '/?lang=pseudo');

    expect(isPseudoLocaleRequested()).toBe(false);
  });
});
