
import { describe, expect, test } from 'bun:test';
import { formatFileSize } from './file-size.ts';

describe('formatFileSize', () => {
  test.each([
    [NaN, ''],
    [Infinity, ''],
    [-Infinity, ''],
    [-1, ''],
    [-1024, ''],

    [0, '0 B'],
    [1, '1 B'],
    [512, '512 B'],
    [1023, '1023 B'],

    [1024, '1 KiB'],
    [1024 ** 2, '1 MiB'],
    [1024 ** 3, '1 GiB'],
    [1024 ** 4, '1 TiB'],

    [1024 ** 5, '1024 TiB'],

    [1024 * 320, '320 KiB'],
    [1024 * 1.5, '1.5 KiB'],
    [1024 * 1.25, '1.3 KiB'], // toFixed(1) rounds 1.25 → 1.3 (round-half-away-from-zero)

    [909_312, '888 KiB'],
    [1_258_291, '1.2 MiB'],
    [48_234_567, '46 MiB'],
  ])('formatFileSize(%p) → %p', (bytes, expected) => {
    expect(formatFileSize(bytes)).toBe(expected);
  });
});
