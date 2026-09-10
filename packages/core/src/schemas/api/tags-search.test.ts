import { describe, expect, test } from 'vitest';
import {
  interpretSkillMoveFailure,
  isSkillMoveRetainedDestinationCode,
  isSkillMoveStateCode,
  isSkillRetentionLedgerCode,
  isSkillSourceStateCode,
  normalizeApiWarnings,
  SKILL_MOVE_RETAINED_DESTINATION,
  SKILL_MOVE_STATE_CODES,
  SKILL_RETENTION_LEDGER_CODES,
  SKILL_SOURCE_STATE_CODES,
  TemplateGetSuccessSchema,
  TemplatePayloadSchema,
} from './tags-search.ts';

const validPayload = (scope: 'local' | 'inherited') => ({
  name: 'daily-journal',
  folder: 'notes',
  scope,
  path: 'notes/.ok/templates/daily-journal.md',
  frontmatter: { title: '{{date}}' },
  body: '## Morning\n',
});

describe('API warning compatibility', () => {
  test('absent warnings remain compatible with older servers', () => {
    expect(normalizeApiWarnings(undefined)).toEqual([]);
    expect(normalizeApiWarnings([])).toEqual([]);
  });

  test.each([null, 'warning', { warning: 'recovery copy deleted' }, [null]])(
    'malformed present warnings remain visibly unverified: %j',
    (value) => {
      expect(normalizeApiWarnings(value).join(' ')).toContain('treat this result as unverified');
    },
  );

  test('unreadable entries do not erase readable warnings', () => {
    const warnings = normalizeApiWarnings(['A recovery copy was deleted.', null]);
    expect(warnings[0]).toBe('A recovery copy was deleted.');
    expect(warnings[1]).toContain('treat this result as unverified');
    expect(normalizeApiWarnings(['A recovery copy was deleted.'])).toEqual([warnings[0]]);
  });
});

describe('move failure compatibility', () => {
  test.each([
    {},
    { moveState: 'nothing-written' },
    { moveState: 'nothing-written', retentionLedger: 'unreadable' },
    { moveState: 'destination-retained', sourceState: 'intact' },
    { moveState: 'destination-retained-blocking', sourceState: 'lossy' },
    { moveState: 'destination-removed' },
  ])('preserves coherent outcomes: %j', (body) => {
    expect(interpretSkillMoveFailure(body)).toEqual({ kind: 'coherent', ...body });
  });

  test.each([
    { moveState: 'future-outcome' },
    { sourceState: 'intact' },
    { retentionLedger: 'future-reason' },
    { moveState: 'destination-retained' },
    { moveState: 'destination-retained', sourceState: 'future-state' },
    { moveState: 'destination-removed', sourceState: 'intact' },
    { moveState: 'destination-retained', sourceState: 'intact', retentionLedger: 'unreadable' },
    { moveState: 'destination-retained', sourceState: 'intact', retentionLedger: 'future-reason' },
  ])('does not treat incomplete or contradictory peer data as coherent: %j', (body) => {
    expect(interpretSkillMoveFailure(body).kind).toBe('unverified');
  });
});

describe('TemplatePayloadSchema.scope', () => {
  test.each(['local', 'inherited'] as const)('accepts scope=%s', (scope) => {
    const result = TemplatePayloadSchema.safeParse(validPayload(scope));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scope).toBe(scope);
    }
  });

  test('rejects unknown scope value', () => {
    const result = TemplatePayloadSchema.safeParse({
      ...validPayload('local'),
      scope: 'global',
    });
    expect(result.success).toBe(false);
  });

  test("rejects scope='user' (user-tier removed)", () => {
    const result = TemplatePayloadSchema.safeParse({
      ...validPayload('local'),
      scope: 'user',
    });
    expect(result.success).toBe(false);
  });
});

describe('TemplateGetSuccessSchema', () => {
  test('frontmatter accepts free-form unknown values', () => {
    const result = TemplateGetSuccessSchema.safeParse({
      template: {
        ...validPayload('local'),
        frontmatter: { title: { '{ date }': null }, tags: ['x'] },
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('skill move-state, source-state and retention-ledger code guards', () => {
  test('the move-state enum carries exactly the seven documented codes', () => {
    expect([...SKILL_MOVE_STATE_CODES]).toEqual([
      'nothing-written',
      'destination-removed',
      'destination-stray',
      'destination-retained',
      'destination-retained-blocking',
      'destination-unreadable',
      'partially-applied',
    ]);
    for (const code of SKILL_MOVE_STATE_CODES) {
      expect(isSkillMoveStateCode(code)).toBe(true);
    }
  });

  test('the source-state enum carries exactly the three documented codes', () => {
    expect([...SKILL_SOURCE_STATE_CODES]).toEqual(['intact', 'lossy', 'unknown']);
    for (const code of SKILL_SOURCE_STATE_CODES) {
      expect(isSkillSourceStateCode(code)).toBe(true);
    }
  });

  test('the retention-ledger enum carries exactly the two documented codes', () => {
    expect([...SKILL_RETENTION_LEDGER_CODES]).toEqual(['unreadable', 'occupant-unverifiable']);
    for (const code of SKILL_RETENTION_LEDGER_CODES) {
      expect(isSkillRetentionLedgerCode(code)).toBe(true);
    }
  });

  test('every move-state code answers the retained-destination question explicitly', () => {
    expect(Object.keys(SKILL_MOVE_RETAINED_DESTINATION).sort()).toEqual(
      [...SKILL_MOVE_STATE_CODES].sort(),
    );
    expect(
      [...SKILL_MOVE_STATE_CODES].filter((code) => isSkillMoveRetainedDestinationCode(code)),
    ).toEqual(['destination-retained', 'destination-retained-blocking']);
  });

  test('all three guards reject near-miss spellings and non-string values', () => {
    const rejected: unknown[] = [
      '',
      ' ',
      'INTACT',
      'Intact',
      'destination_retained',
      'destination-retained ',
      'destination-retained-blocked',
      'partially applied',
      'UNREADABLE',
      'occupant_unverifiable',
      'occupant-unverifiable ',
      null,
      undefined,
      0,
      true,
      ['intact'],
      { code: 'intact' },
    ];
    for (const value of rejected) {
      expect(isSkillMoveStateCode(value)).toBe(false);
      expect(isSkillSourceStateCode(value)).toBe(false);
      expect(isSkillRetentionLedgerCode(value)).toBe(false);
    }
  });

  test('the three enums share no member, so a code identifies which field it came from', () => {
    const all = [
      ...SKILL_MOVE_STATE_CODES,
      ...SKILL_SOURCE_STATE_CODES,
      ...SKILL_RETENTION_LEDGER_CODES,
    ];
    expect(new Set(all).size).toBe(all.length);
  });
});
