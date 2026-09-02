import { describe, expect, test } from 'vitest';
import { clampFlashRange } from './landing-flash-shared';

describe('clampFlashRange', () => {
  test('admits a range at a verified grade', () => {
    expect(clampFlashRange(100, 10, 20, 'exact')).toEqual({ from: 10, to: 20 });
    expect(clampFlashRange(100, 10, 20, 'same-type-ordinal')).toEqual({ from: 10, to: 20 });
  });

  test('refuses the flash at an unverified grade', () => {
    expect(clampFlashRange(100, 10, 20, 'clamped')).toBeNull();
    expect(clampFlashRange(100, 10, 20, 'ordinal')).toBeNull();
  });

  test('clamps a range that runs past the document end', () => {
    expect(clampFlashRange(15, 10, 9999, 'exact')).toEqual({ from: 10, to: 15 });
  });

  test('clamps a negative start to zero', () => {
    expect(clampFlashRange(100, -5, 20, 'exact')).toEqual({ from: 0, to: 20 });
  });

  test('refuses an empty range', () => {
    expect(clampFlashRange(100, 20, 20, 'exact')).toBeNull();
    expect(clampFlashRange(100, 20, 10, 'exact')).toBeNull();
  });

  test('refuses a range wholly past the document end', () => {
    expect(clampFlashRange(15, 40, 60, 'exact')).toBeNull();
  });
});
