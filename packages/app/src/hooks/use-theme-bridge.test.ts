import { describe, expect, test } from 'vitest';
import { cssColorToHex } from './use-theme-bridge';

describe('useThemeBridge — module surface', () => {
  test('exports the useThemeBridge hook', async () => {
    const mod = await import('./use-theme-bridge');
    expect(typeof mod.useThemeBridge).toBe('function');
  });
});

describe('cssColorToHex', () => {
  test('converts legacy rgb / rgba to hex', () => {
    expect(cssColorToHex('rgb(250, 250, 250)')).toBe('#fafafa');
    expect(cssColorToHex('rgb(23, 23, 23)')).toBe('#171717');
    // Alpha is dropped: the window chrome is a solid surface.
    expect(cssColorToHex('rgba(250, 250, 250, 0.5)')).toBe('#fafafa');
    // Space-separated is the modern serialization of the same legacy form.
    expect(cssColorToHex('rgb(250 250 250)')).toBe('#fafafa');
  });

  test('never derives a hex from a non-rgb color syntax', () => {
    // The regression: matching bare numbers against `oklch(0.985 0 0)` read
    // 0.985/0/0 as the channel triple and produced `#010000`, painting the
    // Linux window chrome near-black for the default theme. Without a real
    // conversion available, the answer must be null so the caller falls back
    // to the snapshot.
    for (const value of [
      'oklch(0.985 0 0)',
      'oklch(0.145 0 0)',
      'color(srgb 0.98 0.98 0.98)',
      'lab(97 0 0)',
      'color-mix(in srgb, red, blue)',
    ]) {
      const hex = cssColorToHex(value);
      // Whatever the environment can do, it is either a real hex or nothing —
      // and in a canvas-less environment specifically, never `#010000`.
      expect(hex === null || /^#[0-9a-f]{6}$/.test(hex), `${value} -> ${hex}`).toBe(true);
      expect(hex).not.toBe('#010000');
    }
  });

  test('rejects values that are not colors at all', () => {
    expect(cssColorToHex('')).toBeNull();
    expect(cssColorToHex('var(--sidebar)')).toBeNull();
    expect(cssColorToHex('not a color')).toBeNull();
    expect(cssColorToHex('rgb(300, 0, 0)')).toBeNull();
    expect(cssColorToHex('rgb(1, 2)')).toBeNull();
  });
});
