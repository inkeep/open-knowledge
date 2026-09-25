import { describe, expect, test } from 'vitest';
import { formatRelativeActivity } from './relative-activity';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = 1_000_000_000;

describe('formatRelativeActivity', () => {
  test.each([
    [0, 'just now'],
    [MINUTE - 1, 'just now'],
    [MINUTE, '1m ago'],
    [59 * MINUTE, '59m ago'],
    [59.6 * MINUTE, '1h ago'],
    [90 * MINUTE, '2h ago'],
    [23 * HOUR, '23h ago'],
    [23.6 * HOUR, '1d ago'],
    [36 * HOUR, '2d ago'],
  ])('%d ms of quiet reads as %s', (elapsed, expected) => {
    expect(formatRelativeActivity(NOW - elapsed, NOW)).toBe(expected);
  });

  test('a timestamp later than now reads as just now', () => {
    expect(formatRelativeActivity(NOW + MINUTE, NOW)).toBe('just now');
  });
});
