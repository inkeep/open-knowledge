import { type Bcp47Tag, toLanguageScript } from './bcp47.ts';
import type { LanguagePreference, SupportedLocale } from './locales.ts';

/** The locale served when nothing else matches. */
export const FALLBACK_LOCALE = 'en' satisfies SupportedLocale;

/** Which tier decided the active locale. Reported once at boot as telemetry. */
export type LocaleSource = 'override' | 'explicit' | 'system' | 'fallback';

export interface LocaleResolution {
  readonly locale: SupportedLocale;
  readonly source: LocaleSource;
}

export interface LocaleResolutionInput {
  /** An escape hatch such as `OK_LANG` or `--lang`, absent when unset. */
  readonly override: Bcp47Tag | undefined;
  /** The saved choice, unresolved — `'system'` must arrive as `'system'`. */
  readonly storedPreference: LanguagePreference | undefined;
  /** The ordered OS or browser signal, most-preferred first. */
  readonly preferenceList: readonly Bcp47Tag[];
  /** The catalogs that exist, in the order ties should break. */
  readonly supportedLocales: readonly SupportedLocale[];
  /**
   * The subset of `supportedLocales` the platform signal alone may land on.
   * Defaults to all of them.
   *
   * A stored preference and an override are choices and reach every catalog; a
   * platform signal is a guess, and a surface can have locales it is willing to
   * render on request but not willing to guess into. Narrowing it here rather
   * than in `supportedLocales` is what keeps those two apart.
   */
  readonly autoDetectableLocales?: readonly SupportedLocale[];
}

/**
 * Lookup in the RFC 4647 sense — walk the request in priority order and return
 * the first supported entry that matches — but the match is whole-key equality
 * on maximized `language-Script` tags, not that spec's progressive subtag
 * truncation.
 *
 * Both sides go through the same reduction, which is the whole point — see
 * `toLanguageScript` for what reducing only one side silently costs.
 */
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

/**
 * Decide which locale the interface should activate, and record which tier
 * decided it.
 *
 * Pure — no environment reads, no I/O, no runtime detection. Every runtime
 * supplies its own signals and shares this one policy, so adding a surface
 * means writing a provider rather than a second set of rules.
 *
 * Tiers, highest first:
 *
 * 1. `override`. Negotiated like any other tag, so `OK_LANG=zh-TW` reaches
 *    `zh-Hant`. An unmatched value falls through to the next tier rather than
 *    short-circuiting to the fallback.
 * 2. `storedPreference`, when set and not `'system'`. Matched exactly rather
 *    than negotiated, because an explicit choice should never land somewhere
 *    else. A value that is no longer supported — a hand-edited config, or a
 *    locale withdrawn later — falls through, and is left on disk untouched so
 *    it starts working again if the catalog returns.
 * 3. `preferenceList`, over `autoDetectableLocales` rather than the whole
 *    supported set, so a surface can decline to guess someone into a locale it
 *    would still render on request.
 * 4. `FALLBACK_LOCALE`.
 *
 * An unset preference behaves exactly like `'system'`, so a fresh install
 * follows the OS without anyone having chosen anything.
 *
 * Total: no input, however malformed, throws. Unusable tags are skipped and a
 * request of nothing but garbage lands on the fallback, because a user whose
 * locale cannot be read still needs a usable app.
 */
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
