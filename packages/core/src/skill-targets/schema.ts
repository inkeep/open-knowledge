import { z } from 'zod';
import {
  type EditorId,
  PROJECT_SKILL_EDITOR_IDS,
  USER_SKILL_EDITOR_IDS,
} from '../constants/editors.ts';

type ProjectSkillEditorId = Exclude<
  EditorId,
  'claude-desktop' | 'openclaw' | 'antigravity' | 'lm-studio' | 'hermes'
>;
export const SkillTargetEditorSchema = z.enum(
  PROJECT_SKILL_EDITOR_IDS as unknown as readonly [ProjectSkillEditorId, ...ProjectSkillEditorId[]],
);
export type SkillTargetEditor = z.infer<typeof SkillTargetEditorSchema>;

type UserSkillEditorId = Exclude<EditorId, 'claude-desktop' | 'openclaw' | 'hermes'>;
export const SkillUserTargetEditorSchema = z.enum(
  USER_SKILL_EDITOR_IDS as unknown as readonly [UserSkillEditorId, ...UserSkillEditorId[]],
);
export type SkillUserTargetEditor = z.infer<typeof SkillUserTargetEditorSchema>;

export type SkillInstallTarget = SkillUserTargetEditor | 'agents';
export function isSkillInstallTarget(host: string): host is SkillInstallTarget {
  return host === 'agents' || (USER_SKILL_EDITOR_IDS as readonly string[]).includes(host);
}
