import { describe, expect, test } from 'vitest';
import { loggerFactory } from '../logger.ts';
import { createSkillsInstallRoutes } from './skills-install-routes.ts';

function unexpectedCall(): never {
  throw new Error('Route table construction must not invoke skill services.');
}

function buildGroup() {
  return createSkillsInstallRoutes({
    resolveSkillsRoot: () => '/nonexistent-skills',
    validateSkillName: () => true,
    projectDir: undefined,
    skillInstallBase: () => undefined,
    contentDir: '/nonexistent-content',
    skillsHome: '/nonexistent-skills-home',
    shippedBundleSkillMd: () => null,
    flushDiskAndDetectOutcome: () => Promise.resolve(null),
    respondStaleExternalWrite: unexpectedCall,
    skillInstallOps: {
      resolveFork: unexpectedCall,
      applyAddRemove: unexpectedCall,
      promoteStoreBackedSource: unexpectedCall,
      promoteInPlaceSource: unexpectedCall,
      fanOutInPlace: unexpectedCall,
    },
    skillPlacementOps: {
      place: unexpectedCall,
      unplace: unexpectedCall,
      convert: unexpectedCall,
    },
    signalChannel: undefined,
    bumpSkillsCatalogGen: () => {},
    contentFilter: undefined,
    scheduleDeferredIgnoreRebuild: () => {},
    effectiveInstallMode: () => 'copy',
    log: loggerFactory.getLogger('test'),
  });
}

describe('createSkillsInstallRoutes table', () => {
  test('registers exactly the one skill-install path', () => {
    expect([...buildGroup().paths].sort()).toEqual(['/api/skill/install'].sort());
  });

  test('every skill-install path is mutating (whole-family legacy MUTATING_ROUTES membership)', () => {
    const { table } = buildGroup();
    for (const path of ['/api/skill/install']) {
      expect(table.isMutating(path), path).toBe(true);
    }
  });
});
