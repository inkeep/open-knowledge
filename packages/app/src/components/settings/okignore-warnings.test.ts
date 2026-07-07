import { describe, expect, test } from 'bun:test';
import { checkHeuristicWarnings, WARNING_MESSAGES } from './okignore-warnings';

describe('checkHeuristicWarnings — quiet on uninteresting input', () => {
  test('empty string returns no warnings', () => {
    expect(checkHeuristicWarnings('')).toEqual([]);
  });

  test('plain pattern returns no warnings', () => {
    expect(checkHeuristicWarnings('drafts/')).toEqual([]);
  });

  test('plain glob returns no warnings', () => {
    expect(checkHeuristicWarnings('**/*.draft.md')).toEqual([]);
  });

  test('comment line returns no warnings (metadata, not editable input)', () => {
    expect(checkHeuristicWarnings('# this is a comment')).toEqual([]);
  });

  test('balanced character class returns no warnings', () => {
    expect(checkHeuristicWarnings('foo[abc]bar')).toEqual([]);
  });

  test('close-bracket-only returns no warnings (gitignore tolerates lone ])', () => {
    expect(checkHeuristicWarnings('foo]bar')).toEqual([]);
  });

  test('valid negation with pattern returns no warnings', () => {
    expect(checkHeuristicWarnings('!keep.md')).toEqual([]);
  });
});

describe('checkHeuristicWarnings — trailing backslash', () => {
  test('flags trailing backslash', () => {
    const out = checkHeuristicWarnings('foo\\');
    expect(out.map((w) => w.code)).toEqual(['trailing-backslash']);
    expect(out[0]?.message).toBe(WARNING_MESSAGES['trailing-backslash']);
  });

  test('does not flag escape mid-pattern', () => {
    expect(checkHeuristicWarnings('foo\\bar')).toEqual([]);
  });
});

describe('checkHeuristicWarnings — unmatched bracket', () => {
  test('flags unmatched [ (open-only)', () => {
    const out = checkHeuristicWarnings('foo[abc');
    expect(out.map((w) => w.code)).toEqual(['unmatched-bracket']);
  });

  test('flags more opens than closes', () => {
    expect(checkHeuristicWarnings('a[b[c]').map((w) => w.code)).toEqual(['unmatched-bracket']);
  });

  test('does NOT flag balanced pairs', () => {
    expect(checkHeuristicWarnings('a[b]c[d]e')).toEqual([]);
  });
});

describe('checkHeuristicWarnings — lone bang', () => {
  test('flags lone exclamation mark', () => {
    expect(checkHeuristicWarnings('!').map((w) => w.code)).toEqual(['lone-bang']);
  });

  test('flags lone bang surrounded by whitespace (after trim)', () => {
    // Surrounded whitespace → both leading-whitespace AND lone-bang fire.
    const out = checkHeuristicWarnings('  !  ').map((w) => w.code);
    expect(out).toContain('lone-bang');
  });

  test('does NOT flag negation with body', () => {
    expect(checkHeuristicWarnings('!keep.md')).toEqual([]);
  });
});

describe('checkHeuristicWarnings — leading whitespace', () => {
  test('flags space at start', () => {
    expect(checkHeuristicWarnings(' drafts/').map((w) => w.code)).toEqual(['leading-whitespace']);
  });

  test('flags tab at start', () => {
    expect(checkHeuristicWarnings('\tdrafts/').map((w) => w.code)).toEqual(['leading-whitespace']);
  });

  test('does NOT flag trailing whitespace alone', () => {
    expect(checkHeuristicWarnings('drafts/ ')).toEqual([]);
  });
});

describe('checkHeuristicWarnings — embedded newline', () => {
  test('flags embedded \\n', () => {
    expect(checkHeuristicWarnings('foo\nbar').map((w) => w.code)).toEqual(['embedded-newline']);
  });

  test('flags embedded \\r', () => {
    expect(checkHeuristicWarnings('foo\rbar').map((w) => w.code)).toEqual(['embedded-newline']);
  });

  test('flags CRLF inside row', () => {
    expect(checkHeuristicWarnings('foo\r\nbar').map((w) => w.code)).toEqual(['embedded-newline']);
  });
});

describe('checkHeuristicWarnings — combinations', () => {
  test('leading whitespace + trailing backslash', () => {
    const codes = checkHeuristicWarnings(' drafts/\\').map((w) => w.code);
    expect(codes).toContain('leading-whitespace');
    expect(codes).toContain('trailing-backslash');
  });

  test('embedded newline + leading whitespace', () => {
    const codes = checkHeuristicWarnings(' foo\nbar').map((w) => w.code);
    expect(codes).toContain('embedded-newline');
    expect(codes).toContain('leading-whitespace');
  });

  test('messages are stable strings keyed by code', () => {
    for (const code of [
      'trailing-backslash',
      'unmatched-bracket',
      'lone-bang',
      'leading-whitespace',
      'embedded-newline',
    ] as const) {
      expect(typeof WARNING_MESSAGES[code]).toBe('string');
      expect(WARNING_MESSAGES[code].length).toBeGreaterThan(0);
    }
  });
});

describe('checkHeuristicWarnings — pure / deterministic', () => {
  test('returns a fresh array each call', () => {
    const a = checkHeuristicWarnings('foo\\');
    const b = checkHeuristicWarnings('foo\\');
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  test('does not mutate input string (TS-level guard, but defensive)', () => {
    const input = '  !  ';
    checkHeuristicWarnings(input);
    expect(input).toBe('  !  ');
  });
});
