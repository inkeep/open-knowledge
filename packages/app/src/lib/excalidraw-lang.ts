import { SUPPORTED_LOCALES, type SupportedLocale } from '@inkeep/open-knowledge-core';

export const EXCALIDRAW_FALLBACK_LANG_CODE = 'en';

const EXCALIDRAW_LANG_CODE_BY_LOCALE = {
  en: 'en',
  'zh-Hans': 'zh-CN',
  'zh-Hant': 'zh-TW',
  hi: null,
  es: 'es-ES',
  ar: 'ar-SA',
  fr: 'fr-FR',
  bn: null,
  'pt-BR': 'pt-BR',
  id: 'id-ID',
  ur: null,
  ko: 'ko-KR',
} as const satisfies Record<SupportedLocale, string | null>;

export const BOARD_FALLBACK_LOCALES = SUPPORTED_LOCALES.filter(
  (locale) => EXCALIDRAW_LANG_CODE_BY_LOCALE[locale] === null,
);

function isMappedLocale(locale: string): locale is SupportedLocale {
  return Object.hasOwn(EXCALIDRAW_LANG_CODE_BY_LOCALE, locale);
}

export function excalidrawLangCode(locale: string): string {
  if (!isMappedLocale(locale)) return EXCALIDRAW_FALLBACK_LANG_CODE;
  return EXCALIDRAW_LANG_CODE_BY_LOCALE[locale] ?? EXCALIDRAW_FALLBACK_LANG_CODE;
}
