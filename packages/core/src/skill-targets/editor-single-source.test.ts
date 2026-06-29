
import { describe, expect, test } from 'bun:test';
import {
  ALL_EDITOR_IDS,
  EDITOR_PROJECT_SKILL_ROOT,
  HOSTS_WITH_USER_SKILL_DIR,
  PROJECT_SKILL_EDITOR_IDS,
} from '../constants/editors.ts';
import { SkillTargetEditorSchema } from './schema.ts';

describe('project-skill editor-id single source', () => {
  const asStrings = (xs: readonly string[]) => xs.map(String);

  test('PROJECT_SKILL_EDITOR_IDS = exactly the editors with a non-null project-skill root', () => {
    const expected = ALL_EDITOR_IDS.filter((id) => EDITOR_PROJECT_SKILL_ROOT[id] !== null);
    expect(asStrings(PROJECT_SKILL_EDITOR_IDS)).toEqual(asStrings(expected));
  });

  test('SkillTargetEditorSchema.options is exactly PROJECT_SKILL_EDITOR_IDS (the wire enum derives from it)', () => {
    expect(asStrings(SkillTargetEditorSchema.options)).toEqual(asStrings(PROJECT_SKILL_EDITOR_IDS));
  });

  test('HOSTS_WITH_USER_SKILL_DIR derives from the same editors (CLI repair-skills ↔ desktop skill-reclaim share it)', () => {
    expect(asStrings(HOSTS_WITH_USER_SKILL_DIR.map((h) => h.editorId))).toEqual(
      asStrings(PROJECT_SKILL_EDITOR_IDS),
    );
    for (const { hostDir, editorId } of HOSTS_WITH_USER_SKILL_DIR) {
      expect(hostDir).toBe((EDITOR_PROJECT_SKILL_ROOT[editorId] ?? '').split('/')[0]);
      expect(hostDir.startsWith('.')).toBe(true);
    }
  });

  test('Claude Desktop is NOT a project-skill install target (user-global only, null root)', () => {
    expect(EDITOR_PROJECT_SKILL_ROOT['claude-desktop']).toBeNull();
    expect(SkillTargetEditorSchema.options).not.toContain('claude-desktop');
  });
});
