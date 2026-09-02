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

  test('recovers the sentinel rather than what it resolved to', () => {
    writeCache({ pref: 'system', locale: 'fr', dir: 'ltr' });
    expect(readCachedLanguagePreference()).toBe('system');
  });

  test('is undefined when nothing has been cached yet', () => {
    expect(readCachedLanguagePreference()).toBeUndefined();
  });

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
