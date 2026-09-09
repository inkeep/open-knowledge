import { describe, expect, test } from 'vitest';
import { createSkillsRecoveryRoutes } from './skills-recovery-routes.ts';

function unexpectedCall(): never {
  throw new Error('Route table construction must not invoke skill services.');
}

function buildGroup() {
  return createSkillsRecoveryRoutes({
    synthPluginLockEntry: () => null,
    synthBuiltinLockEntry: () => null,
    isValidSkillName: () => true,
    getPrincipal: undefined,
    validateSkillName: () => true,
    rejectReservedBuiltinSkill: () => false,
    shadowRef: undefined,
    contentDir: '/nonexistent-content',
    contentRoot: undefined,
    projectDir: undefined,
    skillsHome: '/nonexistent-skills-home',
    projectSkillDirRel: (name) => `.agents/skills/${name}`,
    attributeOkArtifactWrite: () => {},
    okArtifactKey: () => '',
    commitOkArtifactWrite: () => Promise.resolve(),
    signalChannel: undefined,
    bumpSkillsCatalogGen: () => {},
    contentFilter: undefined,
    scheduleDeferredIgnoreRebuild: () => {},
    effectiveSkillRoot: () => ({ root: '/nonexistent-skills', dirRel: '', realDir: null }),
    skillReimportService: { runSkillReimport: unexpectedCall },
    localSkillHash: () => undefined,
    resolveSkillsRoot: () => '/nonexistent-skills',
    projectImportedSkillCopy: unexpectedCall,
  });
}

describe('createSkillsRecoveryRoutes table', () => {
  test('registers exactly the four skill-recovery paths', () => {
    expect([...buildGroup().paths].sort()).toEqual(
      [
        '/api/skill/restore',
        '/api/skill/reimport',
        '/api/skills/reimport-bulk',
        '/api/skill/revert',
      ].sort(),
    );
  });

  test('every skill-recovery path is mutating (whole-family legacy MUTATING_ROUTES membership)', () => {
    const { table } = buildGroup();
    for (const path of [
      '/api/skill/restore',
      '/api/skill/reimport',
      '/api/skills/reimport-bulk',
      '/api/skill/revert',
    ]) {
      expect(table.isMutating(path), path).toBe(true);
    }
  });
});
