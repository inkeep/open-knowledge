import { FALLBACK_LOCALE, type SupportedLocale } from '@inkeep/open-knowledge-core';
import type { Messages } from '@lingui/core';
import { i18n } from './i18n';

type CatalogLoader = () => Promise<{ readonly default: { readonly messages: unknown } }>;

const CATALOG_LOADERS: Record<SupportedLocale, CatalogLoader> = {
  en: () => import('@/locales/en/messages.json'),
  'zh-Hans': () => import('@/locales/zh-Hans/messages.json'),
  'zh-Hant': () => import('@/locales/zh-Hant/messages.json'),
  hi: () => import('@/locales/hi/messages.json'),
  es: () => import('@/locales/es/messages.json'),
  ar: () => import('@/locales/ar/messages.json'),
  fr: () => import('@/locales/fr/messages.json'),
  bn: () => import('@/locales/bn/messages.json'),
  'pt-BR': () => import('@/locales/pt-BR/messages.json'),
  id: () => import('@/locales/id/messages.json'),
  ur: () => import('@/locales/ur/messages.json'),
  ko: () => import('@/locales/ko/messages.json'),
};

const loadedLocales = new Set<SupportedLocale>([FALLBACK_LOCALE]);

let requestedLocale: SupportedLocale = FALLBACK_LOCALE;

export async function dynamicActivate(locale: SupportedLocale): Promise<void> {
  requestedLocale = locale;

  if (!loadedLocales.has(locale)) {
    const { default: catalog } = await CATALOG_LOADERS[locale]();
    i18n.load(locale, catalog.messages as Messages);
    loadedLocales.add(locale);
  }

  if (requestedLocale !== locale) return;
  i18n.activate(locale);
}
