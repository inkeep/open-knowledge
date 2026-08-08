/**
 * Interface-language telemetry — the signal behind locale promotion.
 *
 * Emits one span when the user changes the language in Settings. Which
 * languages get picked, and how often `'system'` is overridden, is what decides
 * whether a locale earns promotion out of the layout-deferred set and where
 * translation effort goes next; without it that is a guess.
 *
 * Unlike the sibling adoption markers (`terminal-telemetry.ts`,
 * `slides-telemetry.ts`), this one carries attributes. Those deliberately carry
 * none because their payload would be document names and shell I/O — user
 * content. A locale tag is not: `from` and `to` each range over a closed enum
 * (`'system'` plus `SUPPORTED_LOCALES`), so the pair is bounded at
 * `(1 + SUPPORTED_LOCALES.length)²` regardless of how that list grows — well
 * inside the cardinality discipline — and the whole question the event exists
 * to answer is *which* language. A bare marker would record that someone
 * changed language and lose the only part worth having.
 *
 * The preference is reported UNRESOLVED, so `'system'` arrives as `'system'`.
 * Resolving it here would erase the distinction between a user who deliberately
 * chose English and one following an English OS — the two look identical in the
 * resolved value and mean opposite things for promotion.
 *
 * `@opentelemetry/api` returns a no-op tracer when no SDK is registered, so
 * this is zero-cost unless `VITE_OTEL_ENABLED='true'`.
 */
import type { LanguagePreference } from '@inkeep/open-knowledge-core';
import { trace } from '@opentelemetry/api';

const TRACER_NAME = 'open-knowledge-app';

/**
 * The user picked a different interface language.
 *
 * Wrapped so an opt-in OTel SDK fault (a `startSpan`/`end` throw from a
 * misconfigured provider or a flush-while-shutdown race — `@opentelemetry/api`
 * is a third-party boundary that can genuinely throw) cannot escape the picker's
 * change handler and take the language switch down with it. Mirrors the
 * fault-isolation wrap in `lib/terminal-telemetry.ts`.
 */
export function recordLanguagePreferenceChanged({
  from,
  to,
}: {
  from: LanguagePreference;
  to: LanguagePreference;
}): void {
  try {
    trace
      .getTracer(TRACER_NAME)
      .startSpan('ok.language.preferenceChanged', {
        attributes: { 'ok.language.from': from, 'ok.language.to': to },
      })
      .end();
  } catch (err) {
    console.warn(
      '[language-telemetry] span emit failed:',
      err instanceof Error ? err : String(err),
    );
  }
}
