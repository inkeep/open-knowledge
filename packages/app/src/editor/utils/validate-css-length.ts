export type CssLengthValidationResult =
  | { valid: true }
  | { valid: false; reason: 'empty' | 'malformed-syntax' | 'unknown-unit' };

const KEYWORD_VALUES = new Set(['auto', 'inherit', 'initial', 'unset']);

const ALLOWED_UNITS = new Set(['px', '%', 'rem', 'em', 'vh', 'vw', 'ch', 'ex', 'fr']);

const NUMBER_WITH_OPTIONAL_UNIT = /^(-?\d+(?:\.\d+)?)([a-z%]*)$/i;

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

export function cssLengthValidationMessage(validation: CssLengthValidationResult): string | null {
  if (validation.valid) return null;
  switch (validation.reason) {
    case 'empty':
      return null;
    case 'malformed-syntax':
      return 'Enter a number (e.g. 100), a number with a CSS unit (e.g. 100px, 50%, 26rem), or one of: auto, inherit, initial, unset.';
    case 'unknown-unit':
      return 'Unknown CSS unit. Use px, %, rem, em, vh, vw, ch, ex, or fr.';
  }
}
