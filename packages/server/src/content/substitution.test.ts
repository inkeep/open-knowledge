import { describe, expect, it } from 'bun:test';
import {
  applySubstitution,
  SUBSTITUTION_ALLOWLIST,
  todayIsoUtc,
  validateSubstitution,
} from './substitution.ts';

describe('SUBSTITUTION_ALLOWLIST', () => {
  it('contains the two v1 tokens', () => {
    expect([...SUBSTITUTION_ALLOWLIST]).toEqual(['date', 'user']);
  });
});

describe('validateSubstitution', () => {
  it('accepts an empty body', () => {
    expect(validateSubstitution('')).toEqual([]);
  });

  it('accepts a body with no tokens', () => {
    expect(validateSubstitution('# Hello\n\nNo tokens here.')).toEqual([]);
  });

  it('accepts {{date}} and {{user}} in any combination', () => {
    expect(validateSubstitution('{{date}} {{user}} {{date}}')).toEqual([]);
    expect(validateSubstitution('Today is {{date}}.')).toEqual([]);
    expect(validateSubstitution('Hi, {{user}}!')).toEqual([]);
  });

  it('tolerates surrounding whitespace inside the braces', () => {
    expect(validateSubstitution('{{ date }} and {{  user  }}')).toEqual([]);
  });

  it('rejects unknown tokens with offset', () => {
    const errors = validateSubstitution('Hello {{name}}.');
    expect(errors).toEqual([{ token: 'name', offset: 6 }]);
  });

  it('rejects multiple unknown tokens, preserving offsets', () => {
    const errors = validateSubstitution('{{foo}} and {{bar}}');
    expect(errors).toEqual([
      { token: 'foo', offset: 0 },
      { token: 'bar', offset: 12 },
    ]);
  });

  it('reports unknowns alongside known tokens', () => {
    const errors = validateSubstitution('{{date}} and {{title}}');
    expect(errors).toEqual([{ token: 'title', offset: 13 }]);
  });

  it('does not match across newlines (one-line tokens only)', () => {
    expect(validateSubstitution('{{da\nte}}')).toEqual([]);
  });
});

describe('applySubstitution', () => {
  const ctx = { date: '2026-05-03', user: 'Tim Cardona' };

  it('substitutes {{date}} and {{user}}', () => {
    expect(applySubstitution('{{date}} — {{user}}', ctx)).toBe('2026-05-03 — Tim Cardona');
  });

  it('handles repeated tokens', () => {
    expect(applySubstitution('{{date}} {{date}}', ctx)).toBe('2026-05-03 2026-05-03');
  });

  it('tolerates whitespace inside braces', () => {
    expect(applySubstitution('{{ date }}', ctx)).toBe('2026-05-03');
  });

  it('leaves unknown tokens literal (no exception, safety net)', () => {
    expect(applySubstitution('{{date}} {{name}}', ctx)).toBe('2026-05-03 {{name}}');
  });

  it('passes through bodies with no tokens unchanged', () => {
    expect(applySubstitution('# Plain markdown\n', ctx)).toBe('# Plain markdown\n');
  });

  it('does not re-scan substituted values (single-pass)', () => {
    const trickyCtx = { date: '{{user}}', user: 'literal-user' };
    expect(applySubstitution('{{date}}', trickyCtx)).toBe('{{user}}');
  });

  it('substitutes empty user when context.user is empty', () => {
    expect(applySubstitution('Signed, {{user}}', { date: '2026-05-03', user: '' })).toBe(
      'Signed, ',
    );
  });
});

describe('todayIsoUtc', () => {
  it('formats a fixed UTC date as YYYY-MM-DD', () => {
    expect(todayIsoUtc(new Date('2026-05-03T12:00:00Z'))).toBe('2026-05-03');
  });

  it('zero-pads month and day', () => {
    expect(todayIsoUtc(new Date('2026-01-09T00:00:00Z'))).toBe('2026-01-09');
  });

  it('uses UTC, not local time', () => {
    // 2026-01-01T00:30:00Z is 2025-12-31T19:30 in America/New_York.
    // We assert UTC, so January is the answer.
    expect(todayIsoUtc(new Date('2026-01-01T00:30:00Z'))).toBe('2026-01-01');
  });
});
