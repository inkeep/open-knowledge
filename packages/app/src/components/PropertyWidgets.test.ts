import { describe, expect, test } from 'bun:test';
import { format } from 'date-fns';
import { parseFromInput } from './PropertyWidgets';

describe('PropertyWidgets — parseFromInput', () => {
  // Regression: `new Date('2026-04-24')` interprets the ISO 8601 date-only
  // string as UTC midnight; `format(d,'yyyy-MM-dd')` then formats the local
  // time, producing off-by-one in negative-UTC-offset timezones.
  // `date-fns/parse` parses every format in local time, matching the rest of
  // the widget's local presentation.
  test('ISO 8601 date round-trips losslessly via local-time format', () => {
    const parsed = parseFromInput('2026-04-24');
    expect(parsed).toBeDefined();
    expect(format(parsed as Date, 'yyyy-MM-dd')).toBe('2026-04-24');
  });

  test('display format (`MMM d, yyyy`) — calendar pick → display → parse round-trip', () => {
    const parsed = parseFromInput('Apr 24, 2026');
    expect(parsed).toBeDefined();
    expect(format(parsed as Date, 'yyyy-MM-dd')).toBe('2026-04-24');
  });

  test('full month name (`MMMM d, yyyy`)', () => {
    const parsed = parseFromInput('April 24, 2026');
    expect(parsed).toBeDefined();
    expect(format(parsed as Date, 'yyyy-MM-dd')).toBe('2026-04-24');
  });

  test('US slashed `M/d/yyyy` — disambiguates by explicit format (April 5, not May 4)', () => {
    const parsed = parseFromInput('4/5/2026');
    expect(parsed).toBeDefined();
    expect(format(parsed as Date, 'yyyy-MM-dd')).toBe('2026-04-05');
  });

  test('zero-padded `MM/dd/yyyy`', () => {
    const parsed = parseFromInput('04/05/2026');
    expect(parsed).toBeDefined();
    expect(format(parsed as Date, 'yyyy-MM-dd')).toBe('2026-04-05');
  });

  test('returns undefined on empty / whitespace input', () => {
    expect(parseFromInput('')).toBeUndefined();
    expect(parseFromInput('   ')).toBeUndefined();
  });

  test('returns undefined on non-date prose', () => {
    expect(parseFromInput('not a date')).toBeUndefined();
  });

  test('returns undefined on browser-loose formats not in the explicit set (avoids drift)', () => {
    // `new Date('2026/04/24')` would parse this as local time on most
    // browsers — but accepting browser-dependent formats was the bug.
    // The explicit-format approach rejects rather than guess.
    expect(parseFromInput('2026/04/24')).toBeUndefined();
  });
});
