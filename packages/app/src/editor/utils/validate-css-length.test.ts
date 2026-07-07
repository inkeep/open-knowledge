import { describe, expect, test } from 'bun:test';
import { cssLengthValidationMessage, validateCssLength } from './validate-css-length.ts';

describe('validateCssLength', () => {
  test('empty value returns reason: empty (caller suppresses inline error)', () => {
    expect(validateCssLength('')).toEqual({ valid: false, reason: 'empty' });
    expect(validateCssLength('   ')).toEqual({ valid: false, reason: 'empty' });
  });

  test('unitless numbers are valid (renderer treats as px)', () => {
    expect(validateCssLength('100')).toEqual({ valid: true });
    expect(validateCssLength('0')).toEqual({ valid: true });
    expect(validateCssLength('1.5')).toEqual({ valid: true });
    expect(validateCssLength('  100  ')).toEqual({ valid: true });
  });

  test('numbers with allowlisted CSS units are valid', () => {
    for (const unit of ['px', '%', 'rem', 'em', 'vh', 'vw', 'ch', 'ex', 'fr']) {
      expect(validateCssLength(`100${unit}`)).toEqual({ valid: true });
    }
  });

  test('unit matching is case-insensitive', () => {
    expect(validateCssLength('100PX')).toEqual({ valid: true });
    expect(validateCssLength('26REM')).toEqual({ valid: true });
  });

  test('keyword values (auto / inherit / initial / unset) are valid', () => {
    expect(validateCssLength('auto')).toEqual({ valid: true });
    expect(validateCssLength('AUTO')).toEqual({ valid: true });
    expect(validateCssLength('inherit')).toEqual({ valid: true });
    expect(validateCssLength('initial')).toEqual({ valid: true });
    expect(validateCssLength('unset')).toEqual({ valid: true });
  });

  test('non-numeric / non-keyword strings return malformed-syntax', () => {
    expect(validateCssLength('abc')).toEqual({ valid: false, reason: 'malformed-syntax' });
    expect(validateCssLength('px100')).toEqual({ valid: false, reason: 'malformed-syntax' });
    expect(validateCssLength('100 px')).toEqual({ valid: false, reason: 'malformed-syntax' });
    expect(validateCssLength('calc(100px - 1rem)')).toEqual({
      valid: false,
      reason: 'malformed-syntax',
    });
  });

  test('numbers with unknown units return unknown-unit', () => {
    expect(validateCssLength('100pt')).toEqual({ valid: false, reason: 'unknown-unit' });
    expect(validateCssLength('100cm')).toEqual({ valid: false, reason: 'unknown-unit' });
    expect(validateCssLength('100mm')).toEqual({ valid: false, reason: 'unknown-unit' });
    expect(validateCssLength('100lh')).toEqual({ valid: false, reason: 'unknown-unit' });
  });

  test('negative numbers parse but renderer may reject — validator stays lenient', () => {
    expect(validateCssLength('-100')).toEqual({ valid: true });
    expect(validateCssLength('-100px')).toEqual({ valid: true });
  });

  test('leading-dot decimals (`.5px`) are rejected by the current regex', () => {
    // CSS Values Level 4 `<number>` production allows leading-dot
    // notation (`.5` ≡ `0.5`), and browsers accept `.5px` in widths.
    // The validator's regex requires `\d+` before the optional decimal
    // group, so `.5px` falls through as `malformed-syntax`. Pinned
    // explicitly so a future regex tweak that admits leading-dot
    // notation is a deliberate change, not a drive-by widening.
    expect(validateCssLength('.5')).toEqual({ valid: false, reason: 'malformed-syntax' });
    expect(validateCssLength('.5px')).toEqual({ valid: false, reason: 'malformed-syntax' });
    expect(validateCssLength('.25rem')).toEqual({ valid: false, reason: 'malformed-syntax' });
  });

  test('explicit positive sign (`+100`) is rejected by the current regex', () => {
    // Same locality as the leading-dot case — CSS allows `+100px` but
    // the validator's regex only admits `-?` (optional negative). Pin
    // current behavior so a future change is intentional.
    expect(validateCssLength('+100')).toEqual({ valid: false, reason: 'malformed-syntax' });
    expect(validateCssLength('+100px')).toEqual({ valid: false, reason: 'malformed-syntax' });
  });

  test('exponential notation (`1e2px`) is rejected by the current regex', () => {
    // CSS `<number>` admits `1e2` as 100 but the regex's `\d+(?:\.\d+)?`
    // doesn't include the `e[+-]?\d+` exponent suffix. Pin the
    // restriction so a future widening is deliberate.
    expect(validateCssLength('1e2px')).toEqual({ valid: false, reason: 'malformed-syntax' });
  });
});

describe('cssLengthValidationMessage', () => {
  test('valid → null (no error chrome)', () => {
    expect(cssLengthValidationMessage({ valid: true })).toBeNull();
  });

  test('empty → null (caller hides error when field unfilled)', () => {
    expect(cssLengthValidationMessage({ valid: false, reason: 'empty' })).toBeNull();
  });

  test('malformed-syntax → user-facing message names units + every accepted keyword', () => {
    const msg = cssLengthValidationMessage({ valid: false, reason: 'malformed-syntax' });
    expect(msg).toContain('100');
    // Every keyword the validator actually accepts surfaces in the
    // message — `auto` alone was misleading because authors couldn't
    // discover `inherit`/`initial`/`unset` from the error.
    expect(msg).toContain('auto');
    expect(msg).toContain('inherit');
    expect(msg).toContain('initial');
    expect(msg).toContain('unset');
  });

  test('unknown-unit → user-facing message listing the allowlist', () => {
    const msg = cssLengthValidationMessage({ valid: false, reason: 'unknown-unit' });
    expect(msg).toContain('px');
    expect(msg).toContain('rem');
    expect(msg).toContain('%');
  });
});
