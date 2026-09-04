import { homedir } from 'node:os';
import {
  AUTO_DETECTABLE_LOCALES,
  type LanguagePreference,
  type LocaleSource,
  resolveLocale,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from '@inkeep/open-knowledge-core';
import {
  type LocaleEnvironment,
  readConfigSafely,
  readNodeLocaleSignal,
  resolveConfigPath,
} from '@inkeep/open-knowledge-core/server';

export interface LanguageMetadata {
  preference: LanguagePreference;
  locale: SupportedLocale;
  source: LocaleSource;
  systemLanguages: readonly string[];
}

function readStoredPreference(home: string): LanguagePreference {
  const absPath = resolveConfigPath('user', home, home);
  const result = readConfigSafely({ absPath, sideline: false, warn: () => {} });
  return result.value.appearance?.language ?? 'system';
}

export function defaultReadLanguage({
  home = homedir(),
  env = process.env,
}: {
  home?: string;
  env?: LocaleEnvironment;
} = {}): LanguageMetadata {
  const preference = readStoredPreference(home);
  const { override, preferenceList } = readNodeLocaleSignal(env);
  const { locale, source } = resolveLocale({
    override,
    storedPreference: preference,
    supportedLocales: SUPPORTED_LOCALES,
    preferenceList,
    autoDetectableLocales: AUTO_DETECTABLE_LOCALES,
  });
  return { preference, locale, source, systemLanguages: preferenceList };
}
