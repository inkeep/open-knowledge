
import { describe, expect, test } from 'bun:test';
import { ALL_EDITOR_IDS, EDITOR_PROJECT_SKILL_ROOT } from '@inkeep/open-knowledge-core';
import { EDITOR_TARGETS } from './editors.ts';

describe('EDITOR_TARGETS project-skill path lockstep with core root', () => {
  const cwd = '/tmp/proj';

  for (const id of ALL_EDITOR_IDS) {
    test(`${id}: projectSkillPath agrees with EDITOR_PROJECT_SKILL_ROOT`, () => {
      const root = EDITOR_PROJECT_SKILL_ROOT[id];
      const builder = EDITOR_TARGETS[id].projectSkillPath;
      if (root === null) {
        expect(builder).toBeUndefined();
        return;
      }
      expect(builder).toBeDefined();
      const got = builder?.(cwd).split(/[\\/]/).join('/');
      expect(got?.startsWith(`${cwd}/${root}/`)).toBe(true);
      expect(got?.endsWith('/SKILL.md')).toBe(true);
    });
  }
});
