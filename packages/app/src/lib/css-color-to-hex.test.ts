import { describe, expect, test } from 'vitest';
import { cssColorToHex } from './css-color-to-hex';

describe('cssColorToHex Node RGB fallback', () => {
  test('preserves translucent selection colors for xterm', () => {
    expect(cssColorToHex('rgba(80, 120, 255, 0.18)', { alpha: true })).toBe('#5078ff2e');
    expect(cssColorToHex('rgb(80, 120, 255)', { alpha: true })).toBe('#5078ffff');
    expect(cssColorToHex('rgba(80, 120, 255, 0)', { alpha: true })).toBe('#5078ff00');
  });

  test('keeps native chrome colors opaque', () => {
    expect(cssColorToHex('rgba(80, 120, 255, 0.18)')).toBe('#5078ff');
  });

  test('converts legacy rgb and rgba values without losing their channels', () => {
    expect(cssColorToHex('rgb(250, 250, 250)')).toBe('#fafafa');
    expect(cssColorToHex('rgb(23, 23, 23)')).toBe('#171717');
    expect(cssColorToHex('rgba(250, 250, 250, 0.5)')).toBe('#fafafa');
    expect(cssColorToHex('rgb(250 250 250)')).toBe('#fafafa');
  });

  test('leaves CSS Color 4 conversion to the browser canvas', () => {
    for (const value of [
      'oklch(0.985 0 0)',
      'oklch(0.145 0 0)',
      'color(srgb 0.98 0.98 0.98)',
      'lab(97 0 0)',
      'color-mix(in srgb, red, blue)',
    ]) {
      expect(cssColorToHex(value)).toBeNull();
    }
  });

  test('returns null for values the numeric RGB fallback cannot parse', () => {
    for (const value of ['', 'var(--sidebar)', 'not a color', 'rgb(300, 0, 0)', 'rgb(1, 2)']) {
      expect(cssColorToHex(value)).toBeNull();
    }
  });
});
