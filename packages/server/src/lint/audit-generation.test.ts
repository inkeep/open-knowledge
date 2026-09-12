import { describe, expect, test } from 'vitest';
import { type AuditGenerationInputs, composeAuditGeneration } from './audit-generation.ts';

const BASE: AuditGenerationInputs = {
  lintConfigEpoch: 0,
  projectConfigEpoch: 0,
  activeBranch: 'main',
  localTargetGeneration: 0,
};

const MOVES_THE_TOKEN: ReadonlyArray<[string, Partial<AuditGenerationInputs>]> = [
  ['a lint-config mutation', { lintConfigEpoch: 1 }],
  ['a committed project-config mutation', { projectConfigEpoch: 1 }],
  ['a branch switch', { activeBranch: 'detached-abc1234' }],
  ['a local-target index update', { localTargetGeneration: '7' }],
];

describe('composeAuditGeneration', () => {
  test.each(MOVES_THE_TOKEN)('%s changes the token', (_label, change) => {
    expect(composeAuditGeneration({ ...BASE, ...change })).not.toBe(composeAuditGeneration(BASE));
  });

  test('an unchanged world composes the same token, so audits still coalesce', () => {
    expect(composeAuditGeneration({ ...BASE })).toBe(composeAuditGeneration(BASE));
  });

  test('no field can bleed into its neighbour across the separator', () => {
    expect(
      composeAuditGeneration({ ...BASE, lintConfigEpoch: 1, projectConfigEpoch: 15 }),
    ).not.toBe(composeAuditGeneration({ ...BASE, lintConfigEpoch: 11, projectConfigEpoch: 5 }));
  });
});
