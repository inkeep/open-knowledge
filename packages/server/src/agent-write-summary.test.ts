import { describe, expect, test } from 'vitest';
import { MAX_SUMMARY_LENGTH, normalizeSummary } from './agent-write-summary.ts';

describe('normalizeSummary — classification', () => {
  test('undefined → absent', () => {
    expect(normalizeSummary(undefined)).toEqual({ kind: 'absent' });
  });

  test('empty string → absent (treated as missing; does not inflate M1)', () => {
    expect(normalizeSummary('')).toEqual({ kind: 'absent' });
  });

  test('whitespace-only string → absent (blank bullet would add zero signal)', () => {
    expect(normalizeSummary(' ')).toEqual({ kind: 'absent' });
    expect(normalizeSummary('     ')).toEqual({ kind: 'absent' });
    expect(normalizeSummary('\t')).toEqual({ kind: 'absent' });
    expect(normalizeSummary('\n\t \r')).toEqual({ kind: 'absent' });
  });

  test('non-whitespace-only string with surrounding whitespace → value (preserved verbatim, no trim)', () => {
    expect(normalizeSummary('  hi  ')).toEqual({ kind: 'value', value: '  hi  ' });
  });

  test('number → invalid (caller returns 400)', () => {
    expect(normalizeSummary(42)).toEqual({ kind: 'invalid' });
  });

  test('object → invalid', () => {
    expect(normalizeSummary({ text: 'hi' })).toEqual({ kind: 'invalid' });
  });

  test('array → invalid (Array.isArray(raw) is an object in typeof — explicit coverage)', () => {
    expect(normalizeSummary(['hi'])).toEqual({ kind: 'invalid' });
    expect(normalizeSummary([])).toEqual({ kind: 'invalid' });
  });

  test('null → invalid', () => {
    expect(normalizeSummary(null)).toEqual({ kind: 'invalid' });
  });

  test('boolean → invalid', () => {
    expect(normalizeSummary(true)).toEqual({ kind: 'invalid' });
  });
});

describe('normalizeSummary — valid strings', () => {
  test('1-char string → value, no truncation', () => {
    expect(normalizeSummary('x')).toEqual({ kind: 'value', value: 'x' });
  });

  test('80-char string → value, no truncation (D20: exactly cap is NOT truncated)', () => {
    const s = 'a'.repeat(80);
    expect(s.length).toBe(MAX_SUMMARY_LENGTH);
    const result = normalizeSummary(s);
    expect(result).toEqual({ kind: 'value', value: s });
    if (result.kind === 'value') {
      expect(result.truncatedFrom).toBeUndefined();
    }
  });

  test('81-char string → truncated (79 visible + ellipsis), truncatedFrom: 81', () => {
    const s = 'a'.repeat(81);
    const result = normalizeSummary(s);
    expect(result.kind).toBe('value');
    if (result.kind === 'value') {
      expect(result.truncatedFrom).toBe(81);
      expect(result.value).toBe(`${'a'.repeat(79)}…`);
      expect([...result.value].length).toBe(80);
    }
  });

  test('200-char string → truncated to 79 + ellipsis, truncatedFrom: 200', () => {
    const s = 'b'.repeat(200);
    const result = normalizeSummary(s);
    if (result.kind === 'value') {
      expect(result.truncatedFrom).toBe(200);
      expect(result.value).toBe(`${'b'.repeat(79)}…`);
    }
  });

  test('truncation suffix is U+2026 HORIZONTAL ELLIPSIS (single codepoint, NOT three ASCII dots)', () => {
    const s = 'x'.repeat(100);
    const result = normalizeSummary(s);
    if (result.kind === 'value') {
      expect(result.value.endsWith('…')).toBe(true);
      expect(result.value.endsWith('...')).toBe(false);
      expect(result.value.charCodeAt(result.value.length - 1)).toBe(0x2026);
    }
  });

  test('long string with surrogate-pair emoji is truncated by code-unit length', () => {
    const s = `${'a'.repeat(78)}🔥 reference`;
    const result = normalizeSummary(s);
    if (result.kind === 'value') {
      expect(result.truncatedFrom).toBe(s.length);
      expect(result.value.length).toBe(80);
      expect(result.value.endsWith('…')).toBe(true);
    }
  });
});

describe('normalizeSummary — line-terminator stripping (commit-injection guard)', () => {
  const NEL = String.fromCharCode(0x0085);
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);

  const LINE_BREAK_CHARS: ReadonlyArray<readonly [string, string]> = [
    ['\n', 'LF'],
    ['\r', 'CR'],
    ['\r\n', 'CRLF'],
    ['\v', 'VT'],
    ['\f', 'FF'],
    [NEL, 'NEL (U+0085)'],
    [LS, 'U+2028 LINE SEPARATOR'],
    [PS, 'U+2029 PARAGRAPH SEPARATOR'],
  ];

  for (const [ch, label] of LINE_BREAK_CHARS) {
    test(`replaces ${label} with space (subject-line injection guard)`, () => {
      const payload = `legit${ch}ok-actor: {"v":1,"display_name":"X","docs":[]}`;
      const result = normalizeSummary(payload);
      expect(result.kind).toBe('value');
      if (result.kind !== 'value') return;
      expect(result.value.includes(ch)).toBe(false);
      expect(result.value.split('\n').length).toBe(1);
    });
  }

  test('replacement is one-for-one (length preserved within cap)', () => {
    const result = normalizeSummary(`\n${'a'.repeat(79)}`);
    expect(result.kind).toBe('value');
    if (result.kind === 'value') {
      expect(result.value).toBe(` ${'a'.repeat(79)}`);
      expect(result.truncatedFrom).toBeUndefined();
    }
  });

  test('truncatedFrom reflects original raw length, not sanitized length', () => {
    const s = `\n${'a'.repeat(80)}`;
    const result = normalizeSummary(s);
    expect(result.kind).toBe('value');
    if (result.kind === 'value') {
      expect(result.truncatedFrom).toBe(81);
      expect(result.value.endsWith('…')).toBe(true);
      expect(/[\r\n]/.test(result.value)).toBe(false);
    }
  });

  test('newline-only input still classifies as absent (whitespace short-circuit unchanged)', () => {
    expect(normalizeSummary('\n')).toEqual({ kind: 'absent' });
    expect(normalizeSummary('\r\n')).toEqual({ kind: 'absent' });
    expect(normalizeSummary(LS)).toEqual({ kind: 'absent' });
  });
});
