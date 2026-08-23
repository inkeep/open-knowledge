import { describe, expect, test } from 'vitest';
import { PROJECT_SKILL_EDITOR_IDS, USER_SKILL_EDITOR_IDS } from '../constants/editors.ts';
import { SkillTargetEditorSchema, SkillUserTargetEditorSchema } from './schema.ts';

describe('SkillTargetEditorSchema', () => {
  test('matches the derived PROJECT_SKILL_EDITOR_IDS (drift guard)', () => {
    // The hardcoded editor enum and the editor-root-derived id list are two
    // sources for the same set. Adding or removing a project-skill editor
    // surface in EDITOR_PROJECT_SKILL_ROOT must update this enum in lock-step,
    // or skill-target validation and install projection fall out of sync.
    expect([...SkillTargetEditorSchema.options].sort()).toEqual(
      [...PROJECT_SKILL_EDITOR_IDS].sort(),
    );
  });
});

describe('SkillUserTargetEditorSchema', () => {
  test('matches the derived USER_SKILL_EDITOR_IDS (drift guard)', () => {
    expect([...SkillUserTargetEditorSchema.options].sort()).toEqual(
      [...USER_SKILL_EDITOR_IDS].sort(),
    );
  });

  test('is a strict superset of the project vocabulary, adding the user-only hosts', () => {
    // The global install menu, host-arg validation, and cluster ordering all
    // draw from this set; if it ever loses a project editor, a project skill's
    // host becomes inexpressible on global surfaces.
    for (const id of SkillTargetEditorSchema.options) {
      expect(SkillUserTargetEditorSchema.options).toContain(id);
    }
    expect(SkillUserTargetEditorSchema.options).toContain('antigravity');
  });
});
