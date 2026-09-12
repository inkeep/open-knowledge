import { describe, expect, test } from 'vitest';
import { formatRelativeAge, RELATIVE_TIME_UNKNOWN } from './relative-time.ts';

const AT = '2026-08-31T03:15:17.929Z';
const atMs = Date.parse(AT);

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatRelativeAge', () => {
  test.each([
    [0, '0s ago'],
    [30 * SECOND, '30s ago'],
    [59 * SECOND, '59s ago'],
    [MINUTE, '1m ago'],
    [59 * MINUTE, '59m ago'],
    [HOUR, '1h ago'],
    [23 * HOUR, '23h ago'],
    [DAY, '1d ago'],
    [28 * DAY, '28d ago'],
  ])('an age of %ims reads as %s', (offsetMs, expected) => {
    expect(formatRelativeAge(AT, atMs + offsetMs)).toBe(expected);
  });

  test('a clock that ran backwards clamps rather than rendering a negative age', () => {
    expect(formatRelativeAge(AT, atMs - 60 * SECOND)).toBe('0s ago');
  });

  test('an unparseable stamp reads as the unknown marker', () => {
    expect(formatRelativeAge('not-a-date', atMs)).toBe(RELATIVE_TIME_UNKNOWN);
  });

  test('every bucket carries the ago suffix, so no form reads as a bare duration', () => {
    for (const offsetMs of [0, 30 * SECOND, 5 * MINUTE, 3 * HOUR, 28 * DAY]) {
      expect(formatRelativeAge(AT, atMs + offsetMs)).toMatch(/ ago$/);
    }
  });
});
