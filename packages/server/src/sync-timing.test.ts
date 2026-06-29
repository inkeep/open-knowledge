import { describe, expect, test } from 'bun:test';
import { computeRemainingMs } from './sync-timing.ts';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

describe('computeRemainingMs', () => {
  test('returns 0 when lastUtc is null (never fetched — run immediately)', () => {
    const now = Date.now();
    expect(computeRemainingMs(null, 30, now)).toBe(0);
  });

  test('returns remaining ms when last fetch was recent', () => {
    const now = Date.now();
    const lastUtc = new Date(now - 20 * SECOND).toISOString();
    const remaining = computeRemainingMs(lastUtc, 30, now);
    expect(remaining).toBe(10 * SECOND);
  });

  test('returns 0 when interval has already elapsed (overdue)', () => {
    const now = Date.now();
    const lastUtc = new Date(now - 35 * SECOND).toISOString();
    expect(computeRemainingMs(lastUtc, 30, now)).toBe(0);
  });

  test('returns 0 when last fetch was exactly at the interval boundary', () => {
    const now = Date.now();
    const lastUtc = new Date(now - 30 * SECOND).toISOString();
    expect(computeRemainingMs(lastUtc, 30, now)).toBe(0);
  });

  test('returns full interval when last fetch was just now', () => {
    const now = Date.now();
    const lastUtc = new Date(now).toISOString();
    expect(computeRemainingMs(lastUtc, 30, now)).toBe(30 * SECOND);
  });

  test('handles 60s pull interval correctly', () => {
    const now = Date.now();
    const lastUtc = new Date(now - 45 * SECOND).toISOString();
    const remaining = computeRemainingMs(lastUtc, 60, now);
    expect(remaining).toBe(15 * SECOND);
  });

  test('handles 60 min push interval correctly', () => {
    const now = Date.now();
    const lastUtc = new Date(now - 50 * MINUTE).toISOString();
    const remaining = computeRemainingMs(lastUtc, 60 * 60, now);
    expect(remaining).toBe(10 * MINUTE);
  });

  test('returns 0 for corrupt/invalid lastUtc string', () => {
    const now = Date.now();
    expect(computeRemainingMs('not-a-date', 30, now)).toBe(0);
  });

  test('never returns negative values', () => {
    const now = Date.now();
    const lastUtc = new Date(now - 999 * SECOND).toISOString();
    const remaining = computeRemainingMs(lastUtc, 30, now);
    expect(remaining).toBeGreaterThanOrEqual(0);
  });

  test('restart recovery scenario: server restarted mid-interval', () => {
    const simulatedNow = 1_700_000_000_000;
    const lastUtc = new Date(simulatedNow - 22 * SECOND).toISOString();
    const remaining = computeRemainingMs(lastUtc, 30, simulatedNow);
    expect(remaining).toBe(8 * SECOND);
  });
});
