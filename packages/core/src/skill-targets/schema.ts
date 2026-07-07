/**
 * Schema for the per-project skill-targets store at
 * `<projectDir>/.ok/skill-targets.json`.
 *
 * The editable set of editor host dirs OK projects skills into. Unlike the
 * installed-skills marker (`.ok/local/`, per-machine), this lives at `.ok/`
 * root — COMMITTED, so teammates inherit one target set. Changing it
 * re-projects every managed skill (authored + OK's shipped `open-knowledge`
 * bundle) to the new set and reverse-projects from dropped editors.
 *
 * Kept out of `config.yml` deliberately: config is a CRDT Y.Text doc with no
 * programmatic field-patch path, whereas this is a plain atomically-writable
 * JSON file the change-targets action can update server-side. When the file is
 * absent, OK falls back to the editors the project is already configured for.
 *
 * Only editors with a project skill surface are valid targets
 * (`claude` / `cursor` / `codex`; Claude Desktop reads user-global skills).
 */

import { z } from 'zod';
import { type EditorId, PROJECT_SKILL_EDITOR_IDS } from '../constants/editors.ts';
import { OK_DIR } from '../constants/ok-dir.ts';

/** Filename of the committed skill-targets store under `.ok/`. */
export const SKILL_TARGETS_FILENAME = 'skill-targets.json';

/** Path segments relative to the project root (committed — NOT under `local/`). */
export const SKILL_TARGETS_REL = [OK_DIR, SKILL_TARGETS_FILENAME] as const;

/** Schema major version. Bump on breaking shape changes with a migrator. */
export const SKILL_TARGETS_SCHEMA_VERSION = 1;

/**
 * Editor ids valid as install-projection targets. Runtime values come from the
 * single source `PROJECT_SKILL_EDITOR_IDS` (derived from `EDITOR_PROJECT_SKILL_ROOT`)
 * so the two can't drift. z.enum needs a literal tuple, which the derived array's
 * `.filter` widens to `EditorId`, so the cast restates the narrow literal shape:
 * `Exclude<EditorId, 'claude-desktop'>` is exactly the set of editors WITH a
 * project skill surface (`claude` / `cursor` / `codex`). schema.test.ts asserts
 * the cast stays value-equal to the derived list as a backstop.
 */
type ProjectSkillEditorId = Exclude<EditorId, 'claude-desktop'>;
export const SkillTargetEditorSchema = z.enum(
  // Double cast (through `unknown`): the derived array is typed `EditorId[]`,
  // which TS won't directly narrow to the literal tuple z.enum needs. Runtime
  // correctness is guaranteed by construction + the schema.test.ts drift guard.
  PROJECT_SKILL_EDITOR_IDS as unknown as readonly [ProjectSkillEditorId, ...ProjectSkillEditorId[]],
);
export type SkillTargetEditor = z.infer<typeof SkillTargetEditorSchema>;

export const SkillTargetsSchema = z.looseObject({
  schema: z.literal(SKILL_TARGETS_SCHEMA_VERSION),
  targets: z.array(SkillTargetEditorSchema).default([]),
});
export type SkillTargets = z.infer<typeof SkillTargetsSchema>;

/**
 * Parse + validate raw skill-targets JSON. Returns `null` on parse error or
 * schema violation (fail-soft — a corrupt store is treated as "unset", so OK
 * falls back to detection rather than throwing).
 */
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
