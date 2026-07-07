/**
 * Lockstep guard for the CLI `EDITOR_TARGETS` project-skill paths.
 *
 * `EDITOR_TARGETS[id].projectSkillPath(cwd)` re-encodes the per-editor skills
 * root that core owns canonically as `EDITOR_PROJECT_SKILL_ROOT[id]`. Rather
 * than refactor the path builders, this test pins them in lock-step: an editor
 * with a non-null core root must build `<cwd>/<root>/<bundle>/SKILL.md`, and an
 * editor with a null root (Claude Desktop — user-global only) must expose no
 * `projectSkillPath`. If the CLI map drifts from the core root, this fails.
 */

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
        // No project skill surface → no project skill path.
        expect(builder).toBeUndefined();
        return;
      }
      expect(builder).toBeDefined();
      // POSIX-normalize so the assertion holds regardless of platform separator.
      // Pin the part core owns — the `<cwd>/<root>/` prefix (the bundle dir name
      // + `SKILL.md` leaf are CLI-local). If the CLI root drifts from core, fail.
      const got = builder?.(cwd).split(/[\\/]/).join('/');
      expect(got?.startsWith(`${cwd}/${root}/`)).toBe(true);
      expect(got?.endsWith('/SKILL.md')).toBe(true);
    });
  }
});
