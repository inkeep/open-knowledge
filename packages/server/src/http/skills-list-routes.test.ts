import { describe, expect, test } from 'vitest';
import { loggerFactory } from '../logger.ts';
import { createSkillsCatalogCache } from '../skills-catalog-cache.ts';
import { createSkillsListRoutes } from './skills-list-routes.ts';

function buildGroup() {
  return createSkillsListRoutes({
    contentDir: '/nonexistent-content',
    projectDir: undefined,
    skillsHome: '/nonexistent-skills-home',
    contentFilter: undefined,
    catalogCache: createSkillsCatalogCache({
      homeDirOverride: '/nonexistent-skills-home',
      log: loggerFactory.getLogger('test'),
    }),
    resolveSkillsRoot: () => '/nonexistent-skills',
    resolveSkillsList: () => ({ skills: [], truncated: false }),
    skillOriginFor: () => ({ source: 'test', importedAt: '' }),
    localSkillHash: () => undefined,
    effectiveInstallMode: () => 'copy',
    pluginSelfIdentity: () => null,
    synthBuiltinLockEntry: () => null,
    synthPluginLockEntry: () => null,
    pluginUpstreamHash: () => null,
    builtinSkillListEntry: () => null,
    indexedSkillContentPath: () => null,
    healUnservableSkillAdmission: () => Promise.resolve(false),
  });
}

describe('createSkillsListRoutes table', () => {
  test('registers exactly the one skills-list path', () => {
    expect([...buildGroup().paths].sort()).toEqual(['/api/skills'].sort());
  });

  test('the skills-list read is not mutating', () => {
    const { table } = buildGroup();
    for (const path of ['/api/skills']) {
      expect(table.isMutating(path), path).toBe(false);
    }
  });
});
