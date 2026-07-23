import { expect } from 'vitest';

export function assertByteStable(roundTrip: (s: string) => string, source: string): void {
  const once = roundTrip(source);
  expect(once).toBe(source);
  expect(roundTrip(once)).toBe(once);
}

export function assertRoundTripIdempotent(roundTrip: (s: string) => string, out: string): void {
  expect(roundTrip(out)).toBe(out);
}
