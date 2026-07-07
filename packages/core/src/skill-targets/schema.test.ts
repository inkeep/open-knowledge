import { describe, expect, test } from 'bun:test';
import { PROJECT_SKILL_EDITOR_IDS } from '../constants/editors.ts';
import { parseSkillTargets, SkillTargetEditorSchema } from './schema.ts';

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

  test('parseSkillTargets rejects an unknown editor id', () => {
    const raw = JSON.stringify({ schema: 1, targets: ['claude', 'sublime'] });
    expect(parseSkillTargets(raw)).toBeNull();
  });
});
