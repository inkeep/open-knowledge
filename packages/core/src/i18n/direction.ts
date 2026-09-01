import type { SupportedLocale } from './locales.ts';

export type TextDirection = 'ltr' | 'rtl';

interface TextInfoCapable extends Intl.Locale {
  getTextInfo?: () => { readonly direction?: unknown };
}

const STATIC_DIRECTIONS: Record<SupportedLocale, TextDirection> = {
  en: 'ltr',
  'zh-Hans': 'ltr',
  'zh-Hant': 'ltr',
  hi: 'ltr',
  es: 'ltr',
  ar: 'rtl',
  fr: 'ltr',
  bn: 'ltr',
  'pt-BR': 'ltr',
  id: 'ltr',
  ur: 'rtl',
  ko: 'ltr',
};

export function localeDirection(locale: SupportedLocale): TextDirection {
  const candidate: TextInfoCapable = new Intl.Locale(locale);
  const direction = candidate.getTextInfo?.().direction;
  if (direction === 'rtl' || direction === 'ltr') return direction;
  return STATIC_DIRECTIONS[locale];
}
