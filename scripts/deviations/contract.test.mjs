import { describe, expect, test } from 'vitest';
import {
  addDays,
  HORIZON_DAYS,
  horizonProblem,
  ISSUE_URL_RULE,
  isNonBlank,
  isRealDate,
  isRecord,
  reviewState,
  todayUtc,
  trackingProblems,
} from './contract.mjs';

const AS_OF = '2026-10-12';
const OWNERS = ['team-a', 'team-b'];
const complete = (overrides = {}) => ({
  issue: 'https://github.com/inkeep/agents-private/issues/1',
  owner: 'team-a',
  until: '2026-11-01',
  reason: 'a known gap',
  ...overrides,
});
const fields = (entry, options = {}) =>
  trackingProblems(entry, { required: ['issue', 'owner', 'until', 'reason'], owners: OWNERS, ...options });

describe('trackingProblems: timeless field checks, the same for every domain', () => {
  test('a complete record has no problem', () => {
    expect(fields(complete())).toEqual([]);
  });

  test.each(['issue', 'owner', 'until', 'reason'])(
    'a missing, empty or whitespace-only %s is refused by exactly that field',
    (field) => {
      const { [field]: _dropped, ...missing } = complete();
      expect(fields(missing)).toEqual([`has no ${field}`]);
      expect(fields(complete({ [field]: '' }))).toEqual([`has no ${field}`]);
      expect(fields(complete({ [field]: ' \t' }))).toEqual([`has no ${field}`]);
      expect(fields(complete({ [field]: 7 }))).toEqual([`has no ${field}`]);
    },
  );

  test('an issue is a GitHub issue in the inkeep organization or a Linear issue in the inkeep workspace', () => {
    for (const issue of [
      'https://github.com/inkeep/agents-private/issues/42',
      'https://linear.app/inkeep/issue/PRD-1234',
      'https://linear.app/inkeep/issue/PRD-1234/a-title-slug',
    ]) {
      expect(fields(complete({ issue })), issue).toEqual([]);
    }
    for (const issue of [
      'https://github.com/inkeep/agents-private/pull/42',
      'https://github.com/someone-else/agents-private/issues/42',
      'https://linear.app/other/issue/PRD-1234',
      'PRD-1234',
    ]) {
      expect(fields(complete({ issue })), issue).toEqual([
        `has issue ${JSON.stringify(issue)}, which is not ${ISSUE_URL_RULE}`,
      ]);
    }
  });

  test("an owner comes from the domain's own catalog", () => {
    expect(fields(complete({ owner: 'team-b' }))).toEqual([]);
    expect(fields(complete({ owner: 'team-c' }))).toEqual([
      'has owner "team-c", which is not one of team-a, team-b',
    ]);
  });

  test('until is a real calendar date, checked without any as-of day', () => {
    expect(fields(complete({ until: '2024-02-29' }))).toEqual([]);
    for (const until of ['2026-02-30', '2026-13-01', '15/10/2026', 'soon']) {
      expect(fields(complete({ until })), until).toEqual([
        `has until ${JSON.stringify(until)}, which is not a YYYY-MM-DD date`,
      ]);
    }
  });

  test('an optional field may be absent, and is refused when present but blank', () => {
    const optional = (entry) =>
      trackingProblems(entry, { required: ['owner', 'reason'], optional: ['issue'], owners: OWNERS });
    const { issue: _issue, ...noIssue } = complete();
    expect(optional(noIssue)).toEqual([]);
    expect(optional(complete({ issue: '  ' }))).toEqual(['has a blank issue']);
    expect(optional(complete({ issue: 'PRD-1' }))).toEqual([
      `has issue "PRD-1", which is not ${ISSUE_URL_RULE}`,
    ]);
  });

  test('something that is not an object is refused as a whole', () => {
    for (const entry of [null, 'text', ['a'], 7]) {
      expect(fields(entry), JSON.stringify(entry)).toEqual(['is not an object']);
    }
  });
});

describe('horizonProblem: the admission rule, relative to one injected UTC day', () => {
  test(`day ${HORIZON_DAYS} is inside the horizon and day ${HORIZON_DAYS + 1} is not`, () => {
    const horizon = addDays(AS_OF, HORIZON_DAYS);
    expect(horizon).toBe('2027-01-10');
    expect(horizonProblem(horizon, AS_OF)).toBeNull();
    expect(horizonProblem(addDays(horizon, 1), AS_OF)).toBe(
      `has until 2027-01-11, beyond the ${HORIZON_DAYS}-day horizon (2027-01-10)`,
    );
  });

  test('the same date admitted on the next day: the horizon only relaxes as time passes', () => {
    expect(horizonProblem('2027-01-11', AS_OF)).not.toBeNull();
    expect(horizonProblem('2027-01-11', addDays(AS_OF, 1))).toBeNull();
  });

  test('a past date is no horizon problem, and a malformed date is left to the field check', () => {
    expect(horizonProblem('2026-01-01', AS_OF)).toBeNull();
    expect(horizonProblem('soon', AS_OF)).toBeNull();
  });

  test('an as-of day that is not a real date is refused rather than guessed', () => {
    expect(() => horizonProblem('2026-11-01', '2026-02-30')).toThrow(/as-of day/);
    expect(() => horizonProblem('2026-11-01', undefined)).toThrow(/as-of day/);
  });
});

describe('reviewState: expiry is a reported fact, never a field problem', () => {
  test('a record is current through its until day and expired from the day after', () => {
    expect(reviewState(AS_OF, AS_OF)).toBe('current');
    expect(reviewState(addDays(AS_OF, -1), AS_OF)).toBe('expired');
    expect(reviewState(addDays(AS_OF, 1), AS_OF)).toBe('current');
  });

  test('due-soon covers the as-of day through the window it is given, inclusive', () => {
    expect(reviewState(AS_OF, AS_OF, { soonDays: 14 })).toBe('due-soon');
    expect(reviewState(addDays(AS_OF, 14), AS_OF, { soonDays: 14 })).toBe('due-soon');
    expect(reviewState(addDays(AS_OF, 15), AS_OF, { soonDays: 14 })).toBe('current');
  });

  test('an expired record has no field problem', () => {
    expect(fields(complete({ until: addDays(AS_OF, -30) }))).toEqual([]);
    expect(reviewState(addDays(AS_OF, -30), AS_OF)).toBe('expired');
  });

  test('a record without a real date is undated', () => {
    expect(reviewState(undefined, AS_OF)).toBe('undated');
    expect(reviewState('2026-02-30', AS_OF)).toBe('undated');
  });
});

describe('the predicates the domain parsers share', () => {
  test('isNonBlank holds only for a string with a non-whitespace character', () => {
    expect(['x', ' x '].map(isNonBlank)).toEqual([true, true]);
    expect(['', ' \t\n', undefined, null, 7, ['x']].map(isNonBlank)).toEqual([false, false, false, false, false, false]);
  });

  test('isRecord holds for a plain object and not for null, an array or a scalar', () => {
    expect([{}, { a: 1 }].map(isRecord)).toEqual([true, true]);
    expect([null, [], 'x', 7, undefined].map(isRecord)).toEqual([false, false, false, false, false]);
  });
});

describe('dates', () => {
  test('todayUtc reads the UTC day of the instant it is given', () => {
    expect(todayUtc(new Date('2026-10-12T23:59:59Z'))).toBe('2026-10-12');
    expect(todayUtc(new Date('2026-10-13T00:00:00Z'))).toBe('2026-10-13');
  });

  test('isRealDate accepts a leap day and refuses an impossible one', () => {
    expect(isRealDate('2028-02-29')).toBe(true);
    expect(isRealDate('2027-02-29')).toBe(false);
  });
});
