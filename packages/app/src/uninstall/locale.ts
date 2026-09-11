import {
  AUTO_DETECTABLE_LOCALES,
  readBrowserLanguages,
  resolveLocale,
  SUPPORTED_LOCALES,
} from '@inkeep/open-knowledge-core';
import { dynamicActivate } from '@/lib/activate-locale';
import {
  applyLanguageToDom,
  narrowLanguagePreference,
  readCachedLanguagePreference,
} from '@/lib/use-apply-config-language';

export async function activateUninstallLocale(): Promise<void> {
  try {
    const preference =
      narrowLanguagePreference(new URLSearchParams(window.location.search).get('locale')) ??
      readCachedLanguagePreference();
    const { locale } = resolveLocale({
      override: undefined,
      storedPreference: preference,
      preferenceList: readBrowserLanguages(),
      supportedLocales: SUPPORTED_LOCALES,
      autoDetectableLocales: AUTO_DETECTABLE_LOCALES,
    });
    await dynamicActivate(locale);
    applyLanguageToDom({ preference: preference ?? 'system', locale });
  } catch (error) {
    console.warn('Could not load the uninstall language; using English.', error);
  }
}
