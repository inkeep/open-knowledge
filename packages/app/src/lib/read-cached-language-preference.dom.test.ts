/**
 * The launcher window has no CRDT, so it recovers the saved choice from the
 * same cache the pre-paint script reads. Getting this wrong is what shipped a
 * translated menu bar above an English launcher: the menus come from the main
 * process, which reads the preference off disk at boot, while the launcher had
 * no source at all and rendered the bootstrap catalog.
 */
import { beforeEach, describe, expect, test } from 'vitest';
import {
  LANGUAGE_CACHE_STORAGE_KEY,
  readCachedLanguagePreference,
} from './use-apply-config-language';

function writeCache(value: unknown): void {
  localStorage.setItem(LANGUAGE_CACHE_STORAGE_KEY, JSON.stringify(value));
}

describe('readCachedLanguagePreference', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('recovers a concrete saved choice', () => {
    writeCache({ pref: 'zh-Hans', locale: 'zh-Hans', dir: 'ltr' });
    expect(readCachedLanguagePreference()).toBe('zh-Hans');
  });

  // The whole point of caching the unresolved preference beside the resolved
  // locale: reading the locale back would turn "follow the OS" into a fixed
  // pick, and the launcher would stop tracking the system from then on.
  test('recovers the sentinel rather than what it resolved to', () => {
    writeCache({ pref: 'system', locale: 'fr', dir: 'ltr' });
    expect(readCachedLanguagePreference()).toBe('system');
  });

  test('is undefined when nothing has been cached yet', () => {
    expect(readCachedLanguagePreference()).toBeUndefined();
  });

  // A tag that is no longer enumerated must not reach the resolver as if it
  // were valid — the caller treats undefined as "resolve from the browser",
  // which is what a first-ever launch does.
  test('rejects a tag that is not an enumerated locale', () => {
    writeCache({ pref: 'kl-GL', locale: 'en', dir: 'ltr' });
    expect(readCachedLanguagePreference()).toBeUndefined();
  });

  test('survives a corrupt cache entry', () => {
    localStorage.setItem(LANGUAGE_CACHE_STORAGE_KEY, '{not json');
    expect(readCachedLanguagePreference()).toBeUndefined();
  });

  test('survives a cache entry written in an unexpected shape', () => {
    writeCache({ locale: 'es' });
    expect(readCachedLanguagePreference()).toBeUndefined();
  });
});
