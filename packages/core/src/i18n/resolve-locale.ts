import { type Bcp47Tag, toLanguageScript } from './bcp47.ts';
import type { LanguagePreference, SupportedLocale } from './locales.ts';

export const FALLBACK_LOCALE = 'en' satisfies SupportedLocale;

export type LocaleSource = 'override' | 'explicit' | 'system' | 'fallback';

export interface LocaleResolution {
  readonly locale: SupportedLocale;
  readonly source: LocaleSource;
}

export interface LocaleResolutionInput {
  readonly override: Bcp47Tag | undefined;
  readonly storedPreference: LanguagePreference | undefined;
  readonly preferenceList: readonly Bcp47Tag[];
  readonly supportedLocales: readonly SupportedLocale[];
  readonly autoDetectableLocales?: readonly SupportedLocale[];
}

function lookup(
  preferenceList: readonly Bcp47Tag[],
  supportedLocales: readonly SupportedLocale[],
): SupportedLocale | undefined {
  const reduced = supportedLocales.map((locale) => [toLanguageScript(locale), locale] as const);
  for (const preference of preferenceList) {
    const key = toLanguageScript(preference);
    if (key === null) continue;
    const hit = reduced.find(([supportedKey]) => supportedKey === key);
    if (hit !== undefined) return hit[1];
  }
  return undefined;
}

export function resolveLocale(input: LocaleResolutionInput): LocaleResolution {
  const { override, storedPreference, preferenceList, supportedLocales } = input;
  const autoDetectableLocales = input.autoDetectableLocales ?? supportedLocales;

  if (override !== undefined) {
    const matched = lookup([override], supportedLocales);
    if (matched !== undefined) return { locale: matched, source: 'override' };
  }

  if (storedPreference !== undefined && storedPreference !== 'system') {
    if (supportedLocales.includes(storedPreference)) {
      return { locale: storedPreference, source: 'explicit' };
    }
  }

  const matched = lookup(preferenceList, autoDetectableLocales);
  if (matched !== undefined) return { locale: matched, source: 'system' };

  return { locale: FALLBACK_LOCALE, source: 'fallback' };
}
