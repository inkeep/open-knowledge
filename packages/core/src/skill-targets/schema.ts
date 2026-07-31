/**
 * Schema for the per-project skill-targets store at
 * `<projectDir>/.ok/skill-targets.json`.
 *
 * RETIRED with the `.ok/skills` store. Nothing reads or writes this file any
 * more: targets are DETECTED from the editors a project is already configured
 * for, and a skill's reach is per-skill in its install menu. The shape is kept
 * only so an existing committed file still parses — a project that has one can
 * delete it, and new projects never get one.
 *
 * Kept out of `config.yml` deliberately: config is a CRDT Y.Text doc with no
 * programmatic field-patch path, whereas this is a plain atomically-writable
 * JSON file the change-targets action can update server-side. When the file is
 * absent, OK falls back to the editors the project is already configured for.
 *
 * Only editors with a project skill surface are valid targets
 * (`claude` / `cursor` / `codex` / `copilot` / `opencode` / `pi`; Claude Desktop, OpenClaw,
 * and Antigravity read user-global skills only).
 */

import { z } from 'zod';
import { type EditorId, PROJECT_SKILL_EDITOR_IDS } from '../constants/editors.ts';

/**
 * Editor ids valid as install-projection targets. Runtime values come from the
 * single source `PROJECT_SKILL_EDITOR_IDS` (derived from `EDITOR_PROJECT_SKILL_ROOT`)
 * so the two can't drift. z.enum needs a literal tuple, which the derived array's
 * `.filter` widens to `EditorId`, so the cast restates the narrow literal shape:
 * `Exclude<EditorId, 'claude-desktop' | 'openclaw' | 'antigravity' | 'hermes'>`
 * is exactly the set of editors WITH a project skill surface (`claude` /
 * `cursor` / `codex` / `copilot` / `opencode` / `pi`). claude-desktop, openclaw,
 * antigravity, and hermes have a null project skill root (user-global skills
 * only), so they are excluded. schema.test.ts asserts the cast stays
 * value-equal to the derived list as a backstop.
 */
type ProjectSkillEditorId = Exclude<
  EditorId,
  'claude-desktop' | 'openclaw' | 'antigravity' | 'lm-studio' | 'hermes'
>;
export const SkillTargetEditorSchema = z.enum(
  // Double cast (through `unknown`): the derived array is typed `EditorId[]`,
  // which TS won't directly narrow to the literal tuple z.enum needs. Runtime
  // correctness is guaranteed by construction + the schema.test.ts drift guard.
  PROJECT_SKILL_EDITOR_IDS as unknown as readonly [ProjectSkillEditorId, ...ProjectSkillEditorId[]],
);
export type SkillTargetEditor = z.infer<typeof SkillTargetEditorSchema>;

/**
 * The install-verb target vocabulary: the per-project editor set plus the
 * `.agents` hub pseudo-host. ONE membership predicate — the scattered
 * `h === 'agents' || EDITORS.includes(h)` copies it replaces were the
 * breeding ground for vocabulary-gap bugs (a host id the predicate can't
 * express gets silently dropped from set-exact semantics).
 */
export type SkillInstallTarget = SkillTargetEditor | 'agents';
export function isSkillInstallTarget(host: string): host is SkillInstallTarget {
  return host === 'agents' || (PROJECT_SKILL_EDITOR_IDS as readonly string[]).includes(host);
}
