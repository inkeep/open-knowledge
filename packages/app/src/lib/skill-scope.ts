import type { SkillScope, SkillsListEntry } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';

/** Scope render order — global above project (broadest reach first). Shared by
 *  the Settings skills list and the sidebar Skills section. */
export const SKILL_SCOPE_ORDER: readonly SkillScope[] = ['global', 'project'] as const;

/**
 * Per-scope sets of existing skill names, used for create-dialog collision
 * validation. One source so the Settings list and the sidebar "+" agree.
 */
export function skillNameSetsByScope(
  skills: readonly SkillsListEntry[],
): Record<SkillScope, Set<string>> {
  return {
    project: new Set(skills.filter((s) => s.scope === 'project').map((s) => s.name)),
    global: new Set(skills.filter((s) => s.scope === 'global').map((s) => s.name)),
  };
}

/** Shared prefix on OK's shipped pack skills (`open-knowledge-pack-<pack>`). */
const PACK_SKILL_DISPLAY_PREFIX = 'open-knowledge-pack-';

/**
 * Browse-surface display name for a skill: drops the shared
 * `open-knowledge-pack-` prefix so e.g. `open-knowledge-pack-software-lifecycle`
 * (the longest shipped default) reads as `software-lifecycle` and fits a normal
 * sidebar width. DISPLAY-ONLY — the full name stays the identity (rename field,
 * doc path, tooltips); user-authored skills (no prefix) are unchanged.
 */
export function skillDisplayName(name: string): string {
  return name.startsWith(PACK_SKILL_DISPLAY_PREFIX)
    ? name.slice(PACK_SKILL_DISPLAY_PREFIX.length)
    : name;
}

/**
 * Short level titles shared by every skills surface. The `global` scope is
 * user-level (available in every project); `project` is this KB's `.ok/skills`,
 * shared via git. User-facing copy drops the word "scope" entirely.
 */
export function useSkillScopeLabels(): Record<SkillScope, string> {
  const { t } = useLingui();
  return { project: t`Project`, global: t`Global` };
}

/**
 * Full "<level> Skill" labels for the property-panel level pill — the prominent,
 * color-coded switch affordance ("Global Skill" / "Project Skill").
 */
export function useSkillScopePillLabels(): Record<SkillScope, string> {
  const { t } = useLingui();
  return { project: t`Project Skill`, global: t`Global Skill` };
}
