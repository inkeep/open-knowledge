import { describe, expect, test } from 'vitest';
import { createSkillsImportRoutes } from './skills-import-routes.ts';

function unexpectedCall(): never {
  throw new Error('Route table construction must not invoke skill services.');
}

function buildGroup() {
  return createSkillsImportRoutes({
    projectDir: undefined,
    getPrincipal: undefined,
    skillImportService: { runSkillImport: unexpectedCall },
    bumpSkillsCatalogGen: () => {},
    contentFilter: undefined,
    scheduleDeferredIgnoreRebuild: () => {},
    signalChannel: undefined,
    parseSkillScope: () => 'project',
  });
}

describe('createSkillsImportRoutes table', () => {
  test('registers exactly the three skill-import paths', () => {
    expect([...buildGroup().paths].sort()).toEqual(
      ['/api/skill/import', '/api/skills/import-bulk', '/api/skill-upload'].sort(),
    );
  });

  test('every skill-import path is mutating (whole-family legacy MUTATING_ROUTES membership)', () => {
    const { table } = buildGroup();
    for (const path of ['/api/skill/import', '/api/skills/import-bulk', '/api/skill-upload']) {
      expect(table.isMutating(path), path).toBe(true);
    }
  });
});
