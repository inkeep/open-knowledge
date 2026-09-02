import { describe, expect, test } from 'vitest';
import { formatSentAt } from './sent-at';

const NOW = new Date('2026-08-25T18:48:00').getTime();

function weekdayOf(at: number): string {
  return new Date(at).toLocaleString(undefined, { weekday: 'long' });
}

describe('formatSentAt', () => {
  test("a turn from today carries no date at all — 'today' is what the reader is in", () => {
    const at = new Date('2026-08-25T09:12:00').getTime();
    const stamp = formatSentAt(at, NOW);
    expect(stamp).toContain(new Date(at).toLocaleTimeString(undefined, { minute: '2-digit' }));
    expect(stamp).not.toContain(weekdayOf(at));
    expect(stamp).not.toMatch(/2026/);
  });

  test('a turn from earlier this week is named by its weekday', () => {
    const at = new Date('2026-08-19T18:48:00').getTime();
    expect(formatSentAt(at, NOW)).toContain(weekdayOf(at));
  });

  test('a weekday would be ambiguous past a week, so an older turn gets the date', () => {
    const at = new Date('2026-08-11T18:48:00').getTime();
    const stamp = formatSentAt(at, NOW);
    expect(stamp).not.toContain(weekdayOf(at));
    expect(stamp).toMatch(/11/);
  });

  test('the year appears only outside the current one', () => {
    expect(formatSentAt(new Date('2026-02-02T10:00:00').getTime(), NOW)).not.toMatch(/2026/);
    expect(formatSentAt(new Date('2025-12-30T10:00:00').getTime(), NOW)).toMatch(/2025/);
  });

  test('the weekday window is exclusive at exactly seven days', () => {
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const atBoundary = NOW - sevenDays;
    expect(formatSentAt(atBoundary + 1, NOW)).toContain(weekdayOf(atBoundary + 1));
    expect(formatSentAt(atBoundary, NOW)).not.toContain(weekdayOf(atBoundary));
    expect(formatSentAt(atBoundary - 1, NOW)).not.toContain(weekdayOf(atBoundary - 1));
  });

  test('a stamp equal to now is today, not a zero-age weekday', () => {
    expect(formatSentAt(NOW, NOW)).toBe(
      new Date(NOW).toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      }),
    );
  });

  test('an explicit locale is honoured over the machine default', () => {
    const at = new Date('2026-08-19T18:48:00').getTime();
    expect(formatSentAt(at, NOW, 'fr-FR')).toContain(
      new Date(at).toLocaleString('fr-FR', { weekday: 'long' }),
    );
  });

  test('a future stamp falls back to the date rather than claiming a weekday just passed', () => {
    const at = new Date('2026-08-27T18:48:00').getTime();
    const stamp = formatSentAt(at, NOW);
    expect(stamp).not.toContain(weekdayOf(at));
    expect(stamp).toMatch(/27/);
  });
});
