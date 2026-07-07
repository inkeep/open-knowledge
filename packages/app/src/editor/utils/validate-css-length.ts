/**
 * CSS-length validator for descriptor string props that opt into
 * `cssLengthInput: true` (e.g. Embed.width, Embed.height). Accepts:
 *
 *   - Unitless numbers: `100`, `1.5` — interpreted as pixels by browsers
 *     when consumed as `width=` / `height=` HTML attrs (HTML 5 sec. 4.7.4)
 *     or as `<number>` in CSS `width` / `height` when wrapped in a
 *     calc(). Embed's renderer treats unitless as px.
 *   - Number + length unit: `100px`, `50%`, `26rem`, `1.25em`, `100vh`,
 *     `100vw`, `4ch`, `2ex`, `1fr`. The unit allowlist is the CSS Values
 *     Level 4 set most relevant for embed sizing — `px`/`%`/`rem`/`em`
 *     cover ≥99% of real use, `vh`/`vw` enable viewport-relative embeds,
 *     `ch`/`ex`/`fr` round out the typeset / grid cases.
 *   - Keyword values: `auto`, `inherit`, `initial`, `unset`.
 *
 * Returns a discriminated `{ valid: true }` | `{ valid: false; reason }`
 * shape — mirrors `validateMediaUrl`'s convention so the PropPanel error
 * surface stays uniform.
 *
 * Pure — no DOM, no React. Exported for unit testing.
 */

export type CssLengthValidationResult =
  | { valid: true }
  | { valid: false; reason: 'empty' | 'malformed-syntax' | 'unknown-unit' };

const KEYWORD_VALUES = new Set(['auto', 'inherit', 'initial', 'unset']);

// Unit allowlist — see JSDoc for rationale.
const ALLOWED_UNITS = new Set(['px', '%', 'rem', 'em', 'vh', 'vw', 'ch', 'ex', 'fr']);

const NUMBER_WITH_OPTIONAL_UNIT = /^(-?\d+(?:\.\d+)?)([a-z%]*)$/i;

/**
 * Validate `value` as a CSS length. Empty strings are considered "no
 * value set" and validate as `{ valid: false, reason: 'empty' }` so the
 * caller can suppress the inline error chrome when the user hasn't
 * typed anything yet.
 */
export function validateCssLength(value: string): CssLengthValidationResult {
  const trimmed = value.trim();
  if (!trimmed) return { valid: false, reason: 'empty' };
  if (KEYWORD_VALUES.has(trimmed.toLowerCase())) return { valid: true };
  const match = trimmed.match(NUMBER_WITH_OPTIONAL_UNIT);
  if (!match) return { valid: false, reason: 'malformed-syntax' };
  const unit = (match[2] ?? '').toLowerCase();
  if (unit === '') return { valid: true }; // unitless → renderer treats as px
  if (!ALLOWED_UNITS.has(unit)) return { valid: false, reason: 'unknown-unit' };
  return { valid: true };
}

/**
 * Human-facing error message for the PropPanel inline-error surface.
 * Empty-string returns `null` so the caller can skip rendering chrome
 * on an unfilled field.
 */
export function cssLengthValidationMessage(validation: CssLengthValidationResult): string | null {
  if (validation.valid) return null;
  switch (validation.reason) {
    case 'empty':
      return null;
    case 'malformed-syntax':
      // Lists every accepted keyword (not just `auto`) so the inline
      // error matches the validator's actual acceptance set.
      return 'Enter a number (e.g. 100), a number with a CSS unit (e.g. 100px, 50%, 26rem), or one of: auto, inherit, initial, unset.';
    case 'unknown-unit':
      return 'Unknown CSS unit. Use px, %, rem, em, vh, vw, ch, ex, or fr.';
  }
}
