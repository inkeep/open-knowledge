import { afterEach, describe, expect, test, vi } from 'vitest';
import enCatalog from '@/locales/en/messages.json';
import { activatePseudoLocale, isPseudoLocaleRequested } from './dev-pseudo-locale';
import { i18n } from './i18n';

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
    history.replaceState(null, '', '/?lang=es');

    expect(isPseudoLocaleRequested()).toBe(false);
  });

  test('a shipped build does not answer to it at all', () => {
    vi.stubEnv('PROD', true);
    history.replaceState(null, '', '/?lang=pseudo');

    expect(isPseudoLocaleRequested()).toBe(false);
  });
});
