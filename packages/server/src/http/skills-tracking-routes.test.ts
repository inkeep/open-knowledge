import { describe, expect, test } from 'vitest';
import { createSkillsTrackingRoutes } from './skills-tracking-routes.ts';

function buildGroup() {
  return createSkillsTrackingRoutes({
    contentDir: '/nonexistent-content',
    projectDir: undefined,
    contentFilter: undefined,
    validateSkillName: () => true,
    indexedSkillContentPath: () => null,
    bumpSkillsCatalogGen: () => {},
    signalChannel: undefined,
  });
}

describe('createSkillsTrackingRoutes table', () => {
  test('registers exactly the one skill-tracking path', () => {
    expect([...buildGroup().paths].sort()).toEqual(['/api/skill/track-in-git'].sort());
  });

  test('every skill-tracking path is mutating (whole-family legacy MUTATING_ROUTES membership)', () => {
    const { table } = buildGroup();
    for (const path of ['/api/skill/track-in-git']) {
      expect(table.isMutating(path), path).toBe(true);
    }
  });
});
