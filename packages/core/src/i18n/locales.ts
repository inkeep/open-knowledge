export const SUPPORTED_LOCALES = [
  'en',
  'zh-Hans',
  'zh-Hant',
  'hi',
  'es',
  'ar',
  'fr',
  'bn',
  'pt-BR',
  'id',
  'ur',
  'ko',
] as const satisfies readonly string[];

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const PICKER_LOCALES = [
  'en',
  'zh-Hans',
  'zh-Hant',
  'hi',
  'es',
  'fr',
  'bn',
  'pt-BR',
  'id',
  'ko',
] as const satisfies readonly SupportedLocale[];

export const LAYOUT_DEFERRED_LOCALES = ['ar', 'ur'] as const satisfies readonly SupportedLocale[];

const layoutDeferred = new Set<string>(LAYOUT_DEFERRED_LOCALES);

export const AUTO_DETECTABLE_LOCALES: readonly SupportedLocale[] = SUPPORTED_LOCALES.filter(
  (locale) => !layoutDeferred.has(locale),
);

export type LanguagePreference = 'system' | SupportedLocale;
