import { describe, expect, test } from 'bun:test';
import { nativePickerValue } from './ColorPickerInput.tsx';

describe('nativePickerValue', () => {
  test('returns lowercased 7-char hex unchanged', () => {
    expect(nativePickerValue('#F05032')).toBe('#f05032');
    expect(nativePickerValue('#abcdef')).toBe('#abcdef');
    expect(nativePickerValue('#000000')).toBe('#000000');
  });

  test('trims whitespace before matching', () => {
    expect(nativePickerValue('  #F05032 ')).toBe('#f05032');
  });

  test('expands 3-char shorthand to 6-char', () => {
    expect(nativePickerValue('#fff')).toBe('#ffffff');
    expect(nativePickerValue('#abc')).toBe('#aabbcc');
    expect(nativePickerValue('#F00')).toBe('#ff0000');
  });

  test('returns safe fallback (#000000) for non-hex strings', () => {
    // The browser's <input type="color"> only honors 7-char `#RRGGBB`.
    // Free-string values like CSS color names / rgb() / var() / empty
    // strings can't seed the picker; black is the inert fallback.
    expect(nativePickerValue('')).toBe('#000000');
    expect(nativePickerValue('red')).toBe('#000000');
    expect(nativePickerValue('rgb(240,80,50)')).toBe('#000000');
    expect(nativePickerValue('hsl(0, 100%, 50%)')).toBe('#000000');
    expect(nativePickerValue('var(--accent)')).toBe('#000000');
    expect(nativePickerValue('#F05')).toBe('#ff0055'); // 3-char path
    expect(nativePickerValue('#F0503')).toBe('#000000'); // 5-char not valid
    expect(nativePickerValue('#F050322')).toBe('#000000'); // 8-char not valid
  });

  test('rejects non-`#`-prefixed hex (no support for bare-hex)', () => {
    expect(nativePickerValue('F05032')).toBe('#000000');
    expect(nativePickerValue('abc')).toBe('#000000');
  });
});
