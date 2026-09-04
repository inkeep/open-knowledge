import {
  AUTO_DETECTABLE_LOCALES,
  type LanguagePreference,
  localeDirection,
  readBrowserLanguages,
  resolveLocale,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from '@inkeep/open-knowledge-core';
import { useEffect } from 'react';
import { dynamicActivate } from './activate-locale';
import { activatePseudoLocale, isPseudoLocaleRequested } from './dev-pseudo-locale';
import {
  dismissLocaleLoadFailureNotice,
  showLocaleLoadFailureNotice,
} from './locale-load-failure-notice';

export const LANGUAGE_CACHE_STORAGE_KEY = 'ok-language-v1';

export interface ApplyLanguageInput {
  preference: LanguagePreference;
  locale: SupportedLocale;
}

export function applyLanguageToDom({ preference, locale }: ApplyLanguageInput): void {
  if (typeof document === 'undefined') return;

  const dir = localeDirection(locale);
  const root = document.documentElement;
  root.lang = locale;
  root.dir = dir;

  try {
    localStorage.setItem(
      LANGUAGE_CACHE_STORAGE_KEY,
      JSON.stringify({ pref: preference, locale, dir }),
    );
  } catch {}
}

export function narrowLanguagePreference(value: unknown): LanguagePreference | undefined {
  if (value === 'system') return 'system';
  return SUPPORTED_LOCALES.includes(value as SupportedLocale)
    ? (value as SupportedLocale)
    : undefined;
}

export function readCachedLanguagePreference(): LanguagePreference | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  try {
    const raw = localStorage.getItem(LANGUAGE_CACHE_STORAGE_KEY);
    if (raw === null) return undefined;
    return narrowLanguagePreference((JSON.parse(raw) as { pref?: unknown }).pref);
  } catch {
    return undefined;
  }
}

export function useApplyConfigLanguage({
  preference,
  userConfigSynced,
}: {
  preference: LanguagePreference | undefined;
  userConfigSynced: boolean;
}): void {
  useEffect(() => {
    if (isPseudoLocaleRequested()) {
      void activatePseudoLocale().catch((error: unknown) => {
        console.warn(
          JSON.stringify({ event: 'ok-pseudo-locale-activate-failed', error: String(error) }),
        );
      });
      return;
    }

    if (!userConfigSynced) return;

    const { locale } = resolveLocale({
      override: undefined,
      storedPreference: preference,
      preferenceList: readBrowserLanguages(),
      supportedLocales: SUPPORTED_LOCALES,
      autoDetectableLocales: AUTO_DETECTABLE_LOCALES,
    });

    let superseded = false;

    dynamicActivate(locale)
      .then(() => {
        if (superseded) return;
        dismissLocaleLoadFailureNotice();
        applyLanguageToDom({ preference: preference ?? 'system', locale });
      })
      .catch((error: unknown) => {
        console.warn(
          JSON.stringify({ event: 'ok-locale-activate-failed', locale, error: String(error) }),
        );
        if (superseded) return;
        showLocaleLoadFailureNotice({ locale });
      });

    return () => {
      superseded = true;
    };
  }, [preference, userConfigSynced]);
}
