import { expect, test } from 'vitest';
import { statMtime, statMtimeMs } from './filesystem-identity.ts';

test('preserves fractional milliseconds from a native nanosecond timestamp', () => {
  expect(statMtimeMs({ mtimeNs: 1700000000123749971n })).toBe(1700000000123.75);
});

test('preserves numeric Stats date rounding', () => {
  expect(statMtime({ mtimeNs: 1700000000123749971n }).toISOString()).toBe(
    '2023-11-14T22:13:20.124Z',
  );
});

test('preserves numeric Stats rounding before the epoch', () => {
  expect(statMtimeMs({ mtimeNs: -1n })).toBe(-9.999999974752427e-7);
});
