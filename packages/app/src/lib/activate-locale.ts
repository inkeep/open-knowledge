/**
 * Per-locale catalog delivery: a locale's catalog is its own chunk, fetched the
 * first time that locale is activated.
 *
 * Every catalog compiles to roughly the size of the whole `en` one, so shipping
 * them eagerly would put several times the main bundle's entire budget in front
 * of first paint for the eleven a given user will never read. Splitting them moves
 * that weight into the combined-chunk budget and costs one fetch per language
 * actually chosen.
 *
 * Each specifier below is spelled out rather than built from a template
 * (``import(`../locales/${locale}/messages.json`)``). A literal specifier is the
 * dynamic-import shape the packaged `file://` renderer already resolves at
 * scale, so it needs no separate proof, and keying the map by locale turns an
 * enumerated locale with no catalog into a compile error instead of a runtime
 * 404.
 *
 * This is the only module that loads a *supported-locale* catalog dynamically;
 * `dev-pseudo-locale.ts` loads the pseudolocale the same way, but its import is
 * dead code in a production build. `i18n.ts` keeps its static `en` import so
 * the uninstall entry — which runs after the server is gone — never waits on a
 * chunk.
 */
import { FALLBACK_LOCALE, type SupportedLocale } from '@inkeep/open-knowledge-core';
import type { Messages } from '@lingui/core';
import { i18n } from './i18n';

type CatalogLoader = () => Promise<{ readonly default: { readonly messages: unknown } }>;

// Annotated rather than `satisfies`: the point is to erase the compiled
// catalogs' inferred JSON shapes at the use site, which `satisfies` would keep.
// Missing and unknown locales are still compile errors either way.
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

// The bootstrap catalog is already in memory — `i18n.ts` loads it statically at
// module load, which is what keeps the fallback readable with no network.
const loadedLocales = new Set<SupportedLocale>([FALLBACK_LOCALE]);

let requestedLocale: SupportedLocale = FALLBACK_LOCALE;

/**
 * Load the catalog for `locale` if it is not in memory yet, then make it the
 * active one.
 *
 * A rejected load is left to the caller: the UI has to stay on the locale the
 * user is currently reading and offer a retry, and swallowing the rejection
 * here would take that decision away from it. Nothing is activated and nothing
 * is recorded as loaded when the fetch fails, so a retry starts clean.
 *
 * Calls that overlap resolve to the most recently requested locale rather than
 * to whichever fetch happened to finish last — a user clicking through the
 * picker faster than the network answers must not land back in a language they
 * already navigated away from.
 */
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
