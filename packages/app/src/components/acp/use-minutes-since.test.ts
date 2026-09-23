import { describe, expect, test } from 'vitest';
import { minutesSince } from './use-minutes-since';

describe('minutesSince', () => {
  test('floors to whole minutes and never reads zero', () => {
    const since = 1_000_000;
    expect(minutesSince(since, since)).toBe(1);
    expect(minutesSince(since, since + 59_000)).toBe(1);
    expect(minutesSince(since, since + 60_000)).toBe(1);
    expect(minutesSince(since, since + 4 * 60_000 + 30_000)).toBe(4);
  });
});
