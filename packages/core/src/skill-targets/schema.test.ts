import { describe, expect, test } from 'vitest';
import { PROJECT_SKILL_EDITOR_IDS, USER_SKILL_EDITOR_IDS } from '../constants/editors.ts';
import { SkillTargetEditorSchema, SkillUserTargetEditorSchema } from './schema.ts';

describe('SkillTargetEditorSchema', () => {
  test('matches the derived PROJECT_SKILL_EDITOR_IDS (drift guard)', () => {
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
    for (const id of SkillTargetEditorSchema.options) {
      expect(SkillUserTargetEditorSchema.options).toContain(id);
    }
    expect(SkillUserTargetEditorSchema.options).toContain('antigravity');
  });
});
