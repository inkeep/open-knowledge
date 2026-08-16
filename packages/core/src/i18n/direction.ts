import type { SupportedLocale } from './locales.ts';

/** Base writing direction of a locale's own copy. */
export type TextDirection = 'ltr' | 'rtl';

/**
 * `Intl.Locale.prototype.getTextInfo`, which TypeScript's `ES2022` lib does not
 * declare — the API reached Baseline in July 2026, well after that target.
 * Narrowed to the one field this reads so the shape is checked rather than cast
 * away, and read defensively because the runtimes below the support floor are
 * ordinary current browsers rather than legacy ones.
 */
interface TextInfoCapable extends Intl.Locale {
  getTextInfo?: () => { readonly direction?: unknown };
}

/**
 * Direction per enumerated locale, for runtimes without `getTextInfo`.
 *
 * Exhaustive by type rather than a list of the two right-to-left members: a
 * locale added to `SUPPORTED_LOCALES` without a direction decided for it is a
 * compile error here, which is the only moment anyone is thinking about it.
 * Values match CLDR, and the test pins them against the platform's own answer
 * so this table cannot quietly disagree with the runtime it stands in for.
 */
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

/**
 * The direction the application chrome lays out in for a given interface locale.
 *
 * Derived rather than stored: direction is a property of the language, so a
 * separate setting could only ever disagree with the one the user picked.
 *
 * This answers for the chrome's own copy and nothing else. Text the user wrote
 * — filenames, titles, tags, document bodies — takes its direction from the
 * text itself, because `dir` inherits and a chrome-derived value applied over
 * user content silently reorders words OpenKnowledge does not own.
 */
export function localeDirection(locale: SupportedLocale): TextDirection {
  const candidate: TextInfoCapable = new Intl.Locale(locale);
  const direction = candidate.getTextInfo?.().direction;
  if (direction === 'rtl' || direction === 'ltr') return direction;
  return STATIC_DIRECTIONS[locale];
}
