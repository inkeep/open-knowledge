/**
 * Compact install count for skills.sh directory rows — `842`, `1.2K`, `718K`,
 * `2.7M`. A thin call into the platform's CLDR compact notation, so the unit, its
 * abbreviation, and the decimal separator are all correct per locale (`2,7 Mio.`
 * in de-DE, `273.3万` in ja-JP) and no count overflows its own unit the way a
 * fixed thousands divisor does.
 *
 * `locale` comes from `useLingui().i18n.locale` at the call site, matching how the
 * file tree formats its truncation count. Construct `Intl.NumberFormat` directly
 * rather than routing through Lingui's `i18n.number()`, which its own typings mark
 * for removal in favor of exactly this call.
 */
export function formatInstalls(n: number, locale: string): string {
  return new Intl.NumberFormat(
    // `i18n.locale` is the empty string until the Lingui catalog activates, and a
    // row can render in that window — `new Intl.NumberFormat('')` throws
    // RangeError, which would take out the whole card. `undefined` means "the
    // runtime's own locale", which is a readable count either way.
    locale || undefined,
    // No `maximumFractionDigits`: CLDR's compact rounding already keeps one
    // decimal below ten of a unit and drops it above (`9.9K`, `589K`, `2.7M`),
    // which is the width this column wants. Forcing `1` widens the common case to
    // `589.4K`.
    { notation: 'compact', compactDisplay: 'short' },
  ).format(n);
}
