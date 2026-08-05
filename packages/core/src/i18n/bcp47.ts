/**
 * A canonical BCP 47 language tag.
 *
 * Branded, and `asBcp47Tag` is the only way to mint one, so a POSIX locale id
 * cannot reach the locale matcher. Those ids are the one non-conforming signal
 * in the system — `Intl` rejects `zh_TW.UTF-8`, `es_ES@euro` and `C` with a
 * `RangeError` — and keeping them out by type leaves the conversion at the
 * provider boundary where the platform quirk belongs, rather than as a special
 * case inside the matcher.
 *
 * Browser-safe: platform-neutral globals only.
 */
export type Bcp47Tag = string & { readonly __brand: 'Bcp47Tag' };

type Assert<T extends true> = T;

/**
 * Fails the build if the brand is ever dropped. Without it a raw `LANG` value
 * flows into the matcher and the failure reappears as a runtime `RangeError`,
 * which is exactly what the brand exists to prevent.
 */
type _RawStringIsNotABcp47Tag = Assert<string extends Bcp47Tag ? false : true>;

/**
 * Canonicalize a tag, or return `null` when it is not a language tag at all.
 *
 * Providers call this on every value they read from the OS or the browser, so
 * whatever the platform hands back — an empty string, a POSIX id, a stray
 * non-string — is rejected here instead of throwing further down.
 */
export function asBcp47Tag(value: string): Bcp47Tag | null {
  try {
    const canonical = Intl.getCanonicalLocales(value)[0];
    return canonical === undefined ? null : (canonical as Bcp47Tag);
  } catch {
    return null;
  }
}

/**
 * Canonicalize an ordered list of platform-supplied values, dropping the ones
 * that are not language tags.
 *
 * Dropping rather than failing is what every signal provider wants: a browser
 * or an OS that reports one unusable entry in a list of five should still be
 * followed for the other four.
 */
export function toBcp47Tags(values: readonly string[]): readonly Bcp47Tag[] {
  const tags: Bcp47Tag[] = [];
  for (const value of values) {
    const tag = asBcp47Tag(value);
    if (tag !== null) tags.push(tag);
  }
  return tags;
}

/**
 * Reduce a tag to the `language-Script` key negotiation compares on, or `null`
 * when it yields no usable language and script.
 *
 * Canonicalizing is not enough, because most tags omit the script. Unicode's
 * Add Likely Subtags algorithm (https://www.unicode.org/reports/tr35/#Likely_Subtags,
 * reached through `Intl.Locale.prototype.maximize`) supplies it: `zh-TW`
 * becomes `zh-Hant-TW` and `zh-CN` becomes `zh-Hans-CN`, which is what keeps a
 * Traditional reader off the Simplified catalog. Region is then dropped, since
 * the catalogs are per-script rather than per-region.
 *
 * Apply this to BOTH sides of a negotiation. Reducing only the requested side
 * still gets Chinese right, because `zh-Hans` and `zh-Hant` reduce to
 * themselves — and quietly sends every Latin-script locale to the fallback,
 * because a reduced `es-Latn` no longer equals the raw `es` it is compared
 * against.
 */
export function toLanguageScript(tag: string): string | null {
  try {
    const canonical = Intl.getCanonicalLocales(tag)[0];
    if (canonical === undefined) return null;
    const maximized = new Intl.Locale(canonical).maximize();
    if (!maximized.language || !maximized.script) return null;
    return `${maximized.language}-${maximized.script}`;
  } catch {
    // `RangeError` on a malformed tag, `TypeError` on a non-string. Both arrive
    // from OS- and browser-supplied values that no type can vouch for at
    // runtime, and neither may escape the resolver.
    return null;
  }
}
