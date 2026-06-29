import { z } from 'zod';
import { type EditorId, PROJECT_SKILL_EDITOR_IDS } from '../constants/editors.ts';
import { OK_DIR } from '../constants/ok-dir.ts';

export const SKILL_TARGETS_FILENAME = 'skill-targets.json';

export const SKILL_TARGETS_REL = [OK_DIR, SKILL_TARGETS_FILENAME] as const;

export const SKILL_TARGETS_SCHEMA_VERSION = 1;

type ProjectSkillEditorId = Exclude<EditorId, 'claude-desktop'>;
export const SkillTargetEditorSchema = z.enum(
  PROJECT_SKILL_EDITOR_IDS as unknown as readonly [ProjectSkillEditorId, ...ProjectSkillEditorId[]],
);
export type SkillTargetEditor = z.infer<typeof SkillTargetEditorSchema>;

export const SkillTargetsSchema = z.looseObject({
  schema: z.literal(SKILL_TARGETS_SCHEMA_VERSION),
  targets: z.array(SkillTargetEditorSchema).default([]),
});
export type SkillTargets = z.infer<typeof SkillTargetsSchema>;

export function parseSkillTargets(raw: string): SkillTargets | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = SkillTargetsSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
